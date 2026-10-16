using BitlockerSync.Worker.Directory;
using BitlockerSync.Worker.Ingest;
using BitlockerSync.Worker.Options;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BitlockerSync.Worker.Sync;

public enum SyncMode { Delta, Full }

/// <summary>The result of one run, for logs and the next heartbeat.</summary>
public sealed record SyncOutcome(
    SyncMode Mode,
    long? RunId,
    string Status,
    int ComputersSent,
    int KeysSent,
    int OrphansLeft,
    string? ErrorCode,
    DcInfo? Dc)
{
    public bool LdapOk => ErrorCode is null || !ErrorCode.StartsWith("ldap_", StringComparison.Ordinal);
}

/// <summary>
/// One sync run, as specified in the design doc ("Sync worker chi tiet", "Delta sync"):
/// open the run -> snapshot the DC's highestCommittedUSN BEFORE reading -> send computers ->
/// send keys -> fix orphan keys -> complete. The server decides what is stored.
/// </summary>
public sealed class SyncRunner(
    IDirectoryReaderFactory directories,
    IIngestApi api,
    SyncStateStore state,
    IOptions<IngestOptions> ingestOptions,
    TimeProvider time,
    ILogger<SyncRunner> log)
{
    private int BatchSize => ingestOptions.Value.BatchSize;

    public async Task<SyncOutcome> RunAsync(SyncMode requested, CancellationToken ct)
    {
        using var directory = directories.Create();

        DcInfo dc;
        try
        {
            dc = await directory.ConnectAsync(ct);
        }
        catch (DirectoryException ex)
        {
            // Still open and fail a run, so the server records the error and raises an alert.
            log.LogError("Cannot read AD: {Reason}", ex.Message);
            var failedRun = await api.OpenRunAsync(new OpenRunRequest(ModeText(requested), directories.PreferredServer), ct);
            await api.CompleteAsync(failedRun.RunId, Failed(ex.ApiErrorCode), ct);
            return new SyncOutcome(requested, failedRun.RunId, "failed", 0, 0, 0, ex.ApiErrorCode, null);
        }

        var mode = await DecideModeAsync(requested, dc, ct);
        var open = await api.OpenRunAsync(new OpenRunRequest(ModeText(mode), dc.DnsHostName), ct);
        mode = open.Mode == "full" ? SyncMode.Full : SyncMode.Delta; // the server may turn a delta into a full run
        var sinceUsn = mode == SyncMode.Delta ? open.SinceUsn : (long?)null;
        var highestUsn = dc.HighestCommittedUsn; // snapshot before reading: changes made meanwhile are read next time
        log.LogInformation("Run {RunId}: {Mode} from {Dc}, since USN {Since}, up to {Highest}",
            open.RunId, mode, dc.DnsHostName, sinceUsn?.ToString() ?? "-", highestUsn);

        try
        {
            // objectGUID of each computer by DN, so every key is sent with its computer's objectGUID:
            // the server links keys by AD's own id, not by name or DN.
            var owners = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            var computersSent = 0;
            foreach (var batch in directory.ReadComputers(sinceUsn, ct).Chunk(BatchSize))
            {
                foreach (var c in batch) owners[c.Dn] = c.ObjectGuid.ToString();
                await api.SendComputersAsync(new ComputersBatch(open.RunId, batch.Select(ToItem).ToList()), ct);
                computersSent += batch.Length;
            }

            var keysSent = 0;
            var orphans = new List<KeyItem>();
            foreach (var batch in directory.ReadRecoveryKeys(sinceUsn, ct).Chunk(BatchSize))
            {
                var items = batch.Select(k => ToItem(k) with { ComputerObjectGuid = OwnerOf(directory, owners, k.Dn) }).ToList();
                var result = await api.SendKeysAsync(new KeysBatch(open.RunId, items), ct);
                keysSent += batch.Length;
                orphans.AddRange(items.Where(i => result.Orphans.Contains(i.KeyId, StringComparer.OrdinalIgnoreCase)));
            }

            var orphansLeft = orphans.Count == 0 ? 0 : await FixOrphansAsync(directory, open.RunId, orphans, ct);
            var end = directory.ReadDcInfo();

            // With orphans left, keep the old USN so the next delta reads those keys again.
            var reportedUsn = orphansLeft > 0 ? open.SinceUsn : highestUsn;
            var completed = await api.CompleteAsync(open.RunId,
                new CompleteRequest("success", reportedUsn, computersSent, keysSent, orphansLeft, null, end.HighestCommittedUsn), ct);

            var previous = state.Load();
            state.Save(new SyncState(dc.DnsHostName, dc.InvocationId,
                mode == SyncMode.Full && completed.Status == "success" ? Today() : previous.LastFullDate));

            if (completed.Status == "quarantined")
                log.LogWarning("Run {RunId} was quarantined by the server: {Anomalies}", open.RunId,
                    string.Join("; ", completed.Anomalies?.Select(a => a.Message) ?? []));
            else
                log.LogInformation("Run {RunId} {Status}: {Computers} computers, {Keys} keys, {Orphans} orphan keys left, {Deleted} marked deleted",
                    open.RunId, completed.Status, computersSent, keysSent, orphansLeft, completed.MarkedDeleted ?? 0);

            return new SyncOutcome(mode, open.RunId, completed.Status, computersSent, keysSent, orphansLeft, null, dc);
        }
        catch (DirectoryException ex)
        {
            log.LogError("Run {RunId} failed reading AD: {Reason}", open.RunId, ex.Message);
            await TryCompleteFailedAsync(open.RunId, ex.ApiErrorCode, ct);
            return new SyncOutcome(mode, open.RunId, "failed", 0, 0, 0, ex.ApiErrorCode, dc);
        }
        catch (IngestException ex)
        {
            log.LogError("Run {RunId} failed talking to the API: {Reason}", open.RunId, ex.Message);
            await TryCompleteFailedAsync(open.RunId, "api_unreachable", ct);
            return new SyncOutcome(mode, open.RunId, "failed", 0, 0, 0, "api_unreachable", dc);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Service stopping (e.g. for an update): close the run so the next start is not refused
            // with run_in_progress for two hours. Nothing was committed past the last USN.
            log.LogWarning("Run {RunId} cancelled: the service is stopping", open.RunId);
            using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await TryCompleteFailedAsync(open.RunId, "cancelled", shutdown.Token);
            throw;
        }
    }

    /// <summary>
    /// A delta is only valid against the same, un-restored DC. A restored DC has a new invocationId
    /// and may have a lower USN than we last stored: then read everything again.
    /// </summary>
    private async Task<SyncMode> DecideModeAsync(SyncMode requested, DcInfo dc, CancellationToken ct)
    {
        if (requested == SyncMode.Full) return SyncMode.Full;
        var saved = state.Load();
        if (string.Equals(saved.DcName, dc.DnsHostName, StringComparison.OrdinalIgnoreCase)
            && saved.InvocationId is { } before && dc.InvocationId is { } now && before != now)
        {
            log.LogWarning("DC {Dc} has a new invocationId (restored from backup?): running a full sync", dc.DnsHostName);
            return SyncMode.Full;
        }
        var last = await api.GetLastRunAsync(ct);
        if (last is not null && string.Equals(last.DcName, dc.DnsHostName, StringComparison.OrdinalIgnoreCase)
            && dc.HighestCommittedUsn < last.HighestUsn)
        {
            log.LogWarning("USN of {Dc} went back ({Now} < {Before}): running a full sync", dc.DnsHostName, dc.HighestCommittedUsn, last.HighestUsn);
            return SyncMode.Full;
        }
        return SyncMode.Delta;
    }

    /// <summary>
    /// Keys whose computer the server did not know: send each key's parent computer, then the keys
    /// again. Returns how many are still orphans.
    /// </summary>
    private async Task<int> FixOrphansAsync(IDirectoryReader directory, long runId, List<KeyItem> orphans, CancellationToken ct)
    {
        log.LogInformation("{Count} orphan keys: sending their computers again", orphans.Count);
        var parents = orphans
            .Select(k => LdapValues.ParentDn(k.Dn))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(directory.ReadComputer)
            .OfType<AdComputer>()
            .Select(ToItem)
            .ToList();
        foreach (var batch in parents.Chunk(BatchSize))
            await api.SendComputersAsync(new ComputersBatch(runId, batch), ct);

        var left = 0;
        foreach (var batch in orphans.Chunk(BatchSize))
            left += (await api.SendKeysAsync(new KeysBatch(runId, batch), ct)).Orphans.Count;
        if (left > 0) log.LogWarning("{Count} keys still have no known computer; they will be read again next run", left);
        return left;
    }

    /// <summary>
    /// objectGUID of the computer that owns a key (the parent of the key object): from the computers
    /// read in this run, else read once from AD and remembered; null when the parent is not visible.
    /// </summary>
    private static string? OwnerOf(IDirectoryReader directory, Dictionary<string, string?> owners, string keyDn)
    {
        var parent = LdapValues.ParentDn(keyDn);
        if (!owners.TryGetValue(parent, out var guid))
        {
            guid = directory.ReadComputer(parent)?.ObjectGuid.ToString();
            owners[parent] = guid;
        }
        return guid;
    }

    private async Task TryCompleteFailedAsync(long runId, string errorCode, CancellationToken ct)
    {
        try
        {
            await api.CompleteAsync(runId, Failed(errorCode), ct);
        }
        catch (Exception ex) when (ex is IngestException or OperationCanceledException)
        {
            // The server aborts runs left open for 2 hours, so this is not fatal.
            log.LogWarning("Could not mark run {RunId} as failed: {Reason}", runId, ex.Message);
        }
    }

    private static CompleteRequest Failed(string errorCode) => new("failed", null, null, null, 1, errorCode, null);

    private static string ModeText(SyncMode mode) => mode == SyncMode.Full ? "full" : "delta";

    private DateOnly Today() => DateOnly.FromDateTime(time.GetLocalNow().DateTime);

    internal static ComputerItem ToItem(AdComputer c) =>
        new(c.ObjectGuid.ToString(), c.Name, c.DnsName, c.Dn, c.OperatingSystem, c.UsnChanged, c.WhenChanged, c.WhenCreated);

    internal static KeyItem ToItem(AdRecoveryKey k) =>
        new(k.KeyId.ToString(), k.Dn, k.RecoveryPassword, k.WhenCreated, k.VolumeGuid?.ToString());
}

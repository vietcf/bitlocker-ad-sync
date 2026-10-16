using BitlockerSync.Worker.Directory;
using BitlockerSync.Worker.Ingest;
using BitlockerSync.Worker.Options;
using BitlockerSync.Worker.Sync;

namespace BitlockerSync.Tests;

/// <summary>An in-memory AD: computers and keys with USNs, a DC identity, optional failure.</summary>
internal sealed class FakeDirectory : IDirectoryReaderFactory
{
    public DcInfo Dc { get; set; } = new("dc01.corp.local", 1000, Guid.Parse("11111111-1111-1111-1111-111111111111"), null);
    public List<AdComputer> Computers { get; } = [];
    public List<AdRecoveryKey> Keys { get; } = [];
    public DirectoryException? ConnectError { get; set; }
    public List<long?> ComputerQueries { get; } = [];

    public string PreferredServer => "dc01.corp.local";

    public IDirectoryReader Create() => new Reader(this);

    public AdComputer AddComputer(int n, string ou = "OU=Computers,OU=HN,DC=corp,DC=local", long usn = 500)
    {
        var c = new AdComputer(Guid.NewGuid(), $"PC-{n}", null, $"CN=PC-{n},{ou}", "Windows 11", usn, null, DateTimeOffset.UtcNow.AddDays(-100));
        Computers.Add(c);
        return c;
    }

    public AdRecoveryKey AddKey(AdComputer owner, long usn = 600, string password = "111111-222222-333333-444444-555555-666666-777777-888888")
    {
        var id = Guid.NewGuid();
        var k = new AdRecoveryKey(id, $"CN=x{{{id}}},{owner.Dn}", password, DateTimeOffset.UtcNow.AddDays(-1), usn);
        Keys.Add(k);
        return k;
    }

    private sealed class Reader(FakeDirectory d) : IDirectoryReader
    {
        public Task<DcInfo> ConnectAsync(CancellationToken ct) =>
            d.ConnectError is { } e ? Task.FromException<DcInfo>(e) : Task.FromResult(d.Dc);

        public DcInfo ReadDcInfo() => d.Dc;

        public IEnumerable<AdComputer> ReadComputers(long? sinceUsn, CancellationToken ct)
        {
            d.ComputerQueries.Add(sinceUsn);
            return d.Computers.Where(c => sinceUsn is null || c.UsnChanged > sinceUsn).ToList();
        }

        public IEnumerable<AdRecoveryKey> ReadRecoveryKeys(long? sinceUsn, CancellationToken ct) =>
            d.Keys.Where(k => sinceUsn is null || k.UsnChanged > sinceUsn).ToList();

        public AdComputer? ReadComputer(string dn) =>
            d.Computers.FirstOrDefault(c => string.Equals(c.Dn, dn, StringComparison.OrdinalIgnoreCase));

        public void Dispose() { }
    }
}

/// <summary>
/// A small model of the server: remembers computers by DN, reports keys of unknown computers as
/// orphans, and records every call in order.
/// </summary>
internal sealed class FakeIngestApi : IIngestApi
{
    public List<string> Calls { get; } = [];
    public HashSet<string> KnownComputerDns { get; } = new(StringComparer.OrdinalIgnoreCase);
    public LastRun? LastRun { get; set; }
    public string? ForcedMode { get; set; }
    public long SinceUsn { get; set; } = 100;
    public string? SyncRequested { get; set; }
    public List<OpenRunRequest> Opened { get; } = [];
    public List<CompleteRequest> Completed { get; } = [];
    public List<HeartbeatRequest> Heartbeats { get; } = [];
    public List<int> ComputerBatchSizes { get; } = [];
    public List<KeyItem> SentKeys { get; } = [];
    public HashSet<string> NeverKnownDns { get; } = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Set to simulate the service stopping while keys are being sent.</summary>
    public CancellationTokenSource? StopWhileSendingKeys { get; set; }

    public int PendingRetries => 0;

    public Task<LastRun?> GetLastRunAsync(CancellationToken ct) { Calls.Add("last"); return Task.FromResult(LastRun); }

    public Task<OpenRunResponse> OpenRunAsync(OpenRunRequest r, CancellationToken ct)
    {
        Calls.Add("open");
        Opened.Add(r);
        var mode = ForcedMode ?? r.Mode;
        return Task.FromResult(new OpenRunResponse(Opened.Count, mode, mode == "full" ? 0 : SinceUsn));
    }

    public Task<ComputersResult> SendComputersAsync(ComputersBatch b, CancellationToken ct)
    {
        Calls.Add("computers");
        ComputerBatchSizes.Add(b.Items.Count);
        foreach (var c in b.Items.Where(c => !NeverKnownDns.Contains(c.Dn))) KnownComputerDns.Add(c.Dn);
        return Task.FromResult(new ComputersResult(b.Items.Count, 0, 0));
    }

    public Task<KeysResult> SendKeysAsync(KeysBatch b, CancellationToken ct)
    {
        SentKeys.AddRange(b.Items);
        Calls.Add("keys");
        if (StopWhileSendingKeys is { } stop)
        {
            stop.Cancel();
            stop.Token.ThrowIfCancellationRequested();
        }
        var orphans = b.Items.Where(k => !KnownComputerDns.Contains(LdapValues.ParentDn(k.Dn))).Select(k => k.KeyId).ToList();
        return Task.FromResult(new KeysResult(b.Items.Count - orphans.Count, 0, 0, orphans));
    }

    public Task<CompleteResult> CompleteAsync(long runId, CompleteRequest r, CancellationToken ct)
    {
        Calls.Add("complete");
        Completed.Add(r);
        return Task.FromResult(new CompleteResult(r.Status, 0, null));
    }

    public Task<HeartbeatResponse> HeartbeatAsync(HeartbeatRequest r, CancellationToken ct)
    {
        Calls.Add("heartbeat");
        Heartbeats.Add(r);
        var requested = SyncRequested;
        SyncRequested = null;
        return Task.FromResult(new HeartbeatResponse(requested));
    }
}

/// <summary>State kept in memory instead of a file.</summary>
internal sealed class MemoryStateStore() : SyncStateStore(Microsoft.Extensions.Options.Options.Create(new ScheduleOptions()))
{
    public SyncState State { get; set; } = new(null, null, null);
    public override SyncState Load() => State;
    public override void Save(SyncState state) => State = state;
}

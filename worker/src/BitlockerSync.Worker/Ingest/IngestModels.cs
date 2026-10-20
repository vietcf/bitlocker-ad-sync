using System.Text;

namespace BitlockerSync.Worker.Ingest;

// Request/response shapes of the ingest API (server/openapi/ingest.openapi.yaml), camelCase on the wire.

public sealed record LastRun(long RunId, string DcName, long HighestUsn, DateTimeOffset FinishedAt);

public sealed record OpenRunRequest(string Mode, string DcName);

public sealed record OpenRunResponse(long RunId, string Mode, long SinceUsn);

public sealed record ComputerItem(
    string ObjectGuid,
    string Name,
    string? DnsName,
    string Dn,
    string? Os,
    long UsnChanged,
    DateTimeOffset? WhenChanged,
    DateTimeOffset? WhenCreated,
    DateTimeOffset? LastLogon = null);

public sealed record ComputersBatch(long RunId, IReadOnlyList<ComputerItem> Items);

public sealed record ComputersResult(int Upserted, int Moved, int Unmapped);

/// <summary>A recovery key on its way to the server. ToString never prints the password.</summary>
/// <remarks>ComputerObjectGuid: objectGUID of the owning computer; the server links the key by it (not by name / DN).</remarks>
public sealed record KeyItem(string KeyId, string Dn, string RecoveryPassword, DateTimeOffset WhenCreated, string? VolumeGuid = null, string? ComputerObjectGuid = null)
{
    private bool PrintMembers(StringBuilder b)
    {
        b.Append($"KeyId = {KeyId}, Dn = {Dn}, VolumeGuid = {VolumeGuid}, ComputerObjectGuid = {ComputerObjectGuid}, RecoveryPassword = [REDACTED], WhenCreated = {WhenCreated:O}");
        return true;
    }
}

public sealed record KeysBatch(long RunId, IReadOnlyList<KeyItem> Items);

public sealed record KeysResult(int Inserted, int Skipped, int EmptyPassword, IReadOnlyList<string> Orphans);

public sealed record CompleteRequest(
    string Status,
    long? HighestUsn,
    int? ComputersSeen,
    int? KeysSeen,
    int Errors,
    string? ErrorCode,
    long? DcHighestUsn);

public sealed record Anomaly(string Code, string Message);

public sealed record CompleteResult(string Status, int? MarkedDeleted, IReadOnlyList<Anomaly>? Anomalies);

public sealed record HeartbeatRequest(
    string WorkerId,
    string? Version,
    string? DcName,
    bool? LdapOk,
    string? LastErrorCode,
    int? QueueLen,
    DateTimeOffset? DcCertExpiresAt,
    DateTimeOffset? CanaryValue);

public sealed record HeartbeatResponse(string? SyncRequested);

/// <summary>An API call that failed. Transient failures (network, timeout, 5xx) are retried.</summary>
public sealed class IngestException(string message, int? status = null, string? code = null, Exception? inner = null)
    : Exception(message, inner)
{
    public int? Status { get; } = status;
    public string? Code { get; } = code;
    public bool IsTransient => Status is null or >= 500 or 408 or 429;
}

/// <summary>The ingest API as the sync logic sees it (an interface so it can be faked in tests).</summary>
public interface IIngestApi
{
    /// <summary>Calls waiting to be retried right now (reported as queueLen in the heartbeat).</summary>
    int PendingRetries { get; }

    Task<LastRun?> GetLastRunAsync(CancellationToken ct);
    Task<OpenRunResponse> OpenRunAsync(OpenRunRequest request, CancellationToken ct);
    Task<ComputersResult> SendComputersAsync(ComputersBatch batch, CancellationToken ct);
    Task<KeysResult> SendKeysAsync(KeysBatch batch, CancellationToken ct);
    Task<CompleteResult> CompleteAsync(long runId, CompleteRequest request, CancellationToken ct);
    Task<HeartbeatResponse> HeartbeatAsync(HeartbeatRequest request, CancellationToken ct);
}

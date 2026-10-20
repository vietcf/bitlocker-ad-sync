using System.Text;

namespace BitlockerSync.Worker.Directory;

/// <summary>What the worker reads from the DC's RootDSE (and the NTDS Settings object).</summary>
public sealed record DcInfo(
    string DnsHostName,
    long HighestCommittedUsn,
    Guid? InvocationId,
    DateTimeOffset? CertificateExpiresAt);

public sealed record AdComputer(
    Guid ObjectGuid,
    string Name,
    string? DnsName,
    string Dn,
    string? OperatingSystem,
    long UsnChanged,
    DateTimeOffset? WhenChanged,
    DateTimeOffset? WhenCreated,
    DateTimeOffset? LastLogon = null); // lastLogonTimestamp: replicated between DCs, accurate to ~14 days

/// <summary>
/// One msFVE-RecoveryInformation object. <see cref="RecoveryPassword"/> is empty when the object
/// was readable but its confidential attribute was not. ToString never prints the password.
/// </summary>
public sealed record AdRecoveryKey(
    Guid KeyId,
    string Dn,
    string RecoveryPassword,
    DateTimeOffset WhenCreated,
    long UsnChanged,
    // msFVE-VolumeGuid: the encrypted volume (C:, D:...) this key protects; a volume can have several keys.
    Guid? VolumeGuid = null)
{
    private bool PrintMembers(StringBuilder b)
    {
        b.Append($"KeyId = {KeyId}, Dn = {Dn}, RecoveryPassword = {(RecoveryPassword.Length > 0 ? "[REDACTED]" : "(empty)")}, ");
        b.Append($"VolumeGuid = {VolumeGuid}, WhenCreated = {WhenCreated:O}, UsnChanged = {UsnChanged}");
        return true;
    }
}

/// <summary>Result of `check` for one OU of Ldap:SearchBases (Error set when it cannot be read).</summary>
public sealed record SearchBaseProbe(string SearchBase, int Computers, int Keys, int KeysWithoutPassword, string? Error);

/// <summary>Why reading the directory failed; maps to the error codes of the ingest API.</summary>
public enum DirectoryErrorKind
{
    Unreachable,
    TlsFailed,
    BindFailed,
    Timeout,
    /// <summary>An OU in Ldap:SearchBases does not exist or cannot be read by the account.</summary>
    SearchBaseFailed,
    Other,
}

public sealed class DirectoryException(DirectoryErrorKind kind, string message, Exception? inner = null)
    : Exception(message, inner)
{
    public DirectoryErrorKind Kind { get; } = kind;

    /// <summary>The errorCode sent to POST /sync-runs/{id}/complete.</summary>
    public string ApiErrorCode => Kind switch
    {
        DirectoryErrorKind.Unreachable => "ldap_unreachable",
        DirectoryErrorKind.TlsFailed => "ldap_tls_failed",
        DirectoryErrorKind.BindFailed => "ldap_bind_failed",
        DirectoryErrorKind.Timeout => "ldap_timeout",
        DirectoryErrorKind.SearchBaseFailed => "ldap_search_base_failed",
        _ => "unknown",
    };
}

/// <summary>A connection to one DC for the duration of a sync run.</summary>
public interface IDirectoryReader : IDisposable
{
    /// <summary>Connects (first reachable server, in configured order), binds and reads the RootDSE.</summary>
    Task<DcInfo> ConnectAsync(CancellationToken ct);

    /// <summary>Reads the RootDSE again (e.g. the USN at the end of a run).</summary>
    DcInfo ReadDcInfo();

    /// <summary>Computer objects; with <paramref name="sinceUsn"/>, only those with uSNChanged &gt; it.</summary>
    IEnumerable<AdComputer> ReadComputers(long? sinceUsn, CancellationToken ct);

    /// <summary>Recovery key objects; with <paramref name="sinceUsn"/>, only those with uSNChanged &gt; it.</summary>
    IEnumerable<AdRecoveryKey> ReadRecoveryKeys(long? sinceUsn, CancellationToken ct);

    /// <summary>One computer object by DN, or null if it does not exist.</summary>
    AdComputer? ReadComputer(string dn);
}

public interface IDirectoryReaderFactory
{
    /// <summary>The configured first (pinned) DC, used to label a run that could not connect at all.</summary>
    string PreferredServer { get; }

    IDirectoryReader Create();
}

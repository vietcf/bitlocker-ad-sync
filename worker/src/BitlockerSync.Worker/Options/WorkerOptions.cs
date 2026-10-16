using System.ComponentModel.DataAnnotations;

namespace BitlockerSync.Worker.Options;

/// <summary>How the connection to the domain controller is protected.</summary>
public enum LdapProtocol
{
    /// <summary>TLS from the first byte, port 636 (recommended).</summary>
    Ldaps,
    /// <summary>Port 389, upgraded to TLS with StartTLS before binding.</summary>
    StartTls,
    /// <summary>Port 389 without TLS. With Negotiate, Kerberos signing + sealing still encrypt the traffic.</summary>
    Ldap,
}

/// <summary>How the worker authenticates to the domain controller.</summary>
public enum LdapAuth
{
    /// <summary>Kerberos/NTLM: the service account (gMSA) by default, or Username/Password if given.</summary>
    Negotiate,
    /// <summary>Simple bind with Username/Password (sent as-is: only safe over TLS).</summary>
    Basic,
}

/// <summary>Where the AD data comes from.</summary>
public enum DirectorySource
{
    Ldap,
    /// <summary>Development only: reads a JSON file shaped like AD data.</summary>
    JsonFile,
}

public sealed class LdapOptions
{
    public const string Section = "Ldap";

    public DirectorySource Source { get; set; } = DirectorySource.Ldap;

    /// <summary>DC host names, tried in order: the first is the pinned DC, the rest are fallbacks.</summary>
    public List<string> Servers { get; set; } = [];

    public LdapProtocol Protocol { get; set; } = LdapProtocol.Ldaps;

    /// <summary>Defaults to 636 for Ldaps, 389 otherwise.</summary>
    public int? Port { get; set; }

    public LdapAuth Auth { get; set; } = LdapAuth.Negotiate;

    /// <summary>
    /// Basic: a UPN (svc-blk@corp.local) or DN. Negotiate: optional, DOMAIN\user or UPN;
    /// leave empty to use the account the service runs as (gMSA).
    /// </summary>
    public string? Username { get; set; }

    /// <summary>Plain text (development) or "dpapi:..." produced by `BitlockerSync.Worker protect`.</summary>
    public string? Password { get; set; }

    /// <summary>Domain naming context, e.g. DC=corp,DC=local.</summary>
    public string BaseDn { get; set; } = "";

    /// <summary>
    /// OUs to read, one after the other (subtree of each). Empty = the whole BaseDn. List only OUs
    /// the account may read: an OU that cannot be read stops the run (see LdapDirectoryReader).
    /// </summary>
    public List<string> SearchBases { get; set; } = [];

    [Range(1, 1000)]
    public int PageSize { get; set; } = 1000;

    [Range(5, 600)]
    public int TimeoutSeconds { get; set; } = 60;

    /// <summary>Lab only: allow a simple bind over plain LDAP (password and keys travel unencrypted).</summary>
    public bool AllowInsecure { get; set; }

    /// <summary>Lab only: accept any DC certificate.</summary>
    public bool SkipCertificateValidation { get; set; }

    /// <summary>For Source = JsonFile.</summary>
    public string JsonFilePath { get; set; } = "sample-directory.json";

    public int EffectivePort => Port ?? (Protocol == LdapProtocol.Ldaps ? 636 : 389);

    /// <summary>SearchBases without duplicates or OUs nested in another listed OU; [BaseDn] when empty.</summary>
    public IReadOnlyList<string> EffectiveSearchBases => Directory.LdapValues.EffectiveSearchBases(SearchBases, BaseDn);
}

public sealed class IngestOptions
{
    public const string Section = "Ingest";

    /// <summary>e.g. https://blk.corp.local:8443/api/ingest</summary>
    [Required]
    public string BaseUrl { get; set; } = "";

    /// <summary>
    /// The worker's only credential (INGEST_API_KEY of the server): plain text (development) or
    /// "dpapi:...". Sent as Authorization: Bearer over HTTPS.
    /// </summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// PEM file of the CA that issued the server's HTTPS certificate, when Windows does not trust it
    /// (e.g. the dev CA of cert/generate-self-signed.sh). A relative path is taken from the program's folder.
    /// </summary>
    public string? CaFile { get; set; }

    [Range(5, 600)]
    public int TimeoutSeconds { get; set; } = 60;

    [Range(1, 500)]
    public int BatchSize { get; set; } = 500;

    /// <summary>How long to keep retrying a failed call (network / 5xx) before giving the run up.</summary>
    [Range(1, 1440)]
    public int RetryForMinutes { get; set; } = 60;

    /// <summary>Lab only: accept any server certificate.</summary>
    public bool SkipCertificateValidation { get; set; }
}

public sealed class ScheduleOptions
{
    public const string Section = "Schedule";

    [Range(1, 1440)]
    public int DeltaEveryMinutes { get; set; } = 15;

    /// <summary>Local time of the nightly full sync, HH:mm.</summary>
    [RegularExpression(@"^([01]\d|2[0-3]):[0-5]\d$")]
    public string FullAt { get; set; } = "01:00";

    [Range(1, 60)]
    public int HeartbeatEveryMinutes { get; set; } = 5;

    /// <summary>Defaults to the machine name.</summary>
    public string? WorkerId { get; set; }

    /// <summary>Small state file (DC, invocationId, last full date). No secrets.</summary>
    public string StateFile { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "BitlockerSync", "state.json");
}

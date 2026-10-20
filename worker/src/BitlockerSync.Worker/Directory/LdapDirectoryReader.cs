using System.DirectoryServices.Protocols;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using BitlockerSync.Worker.Options;
using BitlockerSync.Worker.Security;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BitlockerSync.Worker.Directory;

public sealed class LdapDirectoryReaderFactory(IOptions<LdapOptions> options, ILoggerFactory loggers) : IDirectoryReaderFactory
{
    public string PreferredServer => options.Value.Servers.FirstOrDefault() ?? "unknown";

    public IDirectoryReader Create() => new LdapDirectoryReader(options.Value, loggers.CreateLogger<LdapDirectoryReader>());
}

/// <summary>
/// Reads Active Directory with System.DirectoryServices.Protocols. Read-only.
/// Protocol: Ldaps (636) | StartTls (389 + TLS) | Ldap (389; with Negotiate, Kerberos signing+sealing).
/// Auth: Negotiate (service account / gMSA, or explicit credentials) | Basic (simple bind).
/// </summary>
public sealed class LdapDirectoryReader(LdapOptions options, ILogger<LdapDirectoryReader> log) : IDirectoryReader
{
    private static readonly string[] ComputerAttributes =
        ["objectGUID", "name", "dNSHostName", "distinguishedName", "operatingSystem", "uSNChanged", "whenChanged", "whenCreated", "lastLogonTimestamp"];

    private static readonly string[] KeyAttributes =
        ["msFVE-RecoveryGuid", "msFVE-VolumeGuid", "msFVE-RecoveryPassword", "distinguishedName", "whenCreated", "uSNChanged"];

    private LdapConnection? _connection;
    private string _server = "";
    private DateTimeOffset? _certificateExpiresAt;

    private TimeSpan Timeout => TimeSpan.FromSeconds(options.TimeoutSeconds);

    private LdapConnection Connection => _connection ?? throw new InvalidOperationException("Call ConnectAsync first.");

    public async Task<DcInfo> ConnectAsync(CancellationToken ct)
    {
        DirectoryException? last = null;
        foreach (var server in options.Servers)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                if (!await CanReachAsync(server, ct))
                    throw new DirectoryException(DirectoryErrorKind.Unreachable, $"{server}:{options.EffectivePort} is not reachable.");
                _connection = Open(server);
                _server = server;
                if (options.Protocol == LdapProtocol.Ldaps)
                    _certificateExpiresAt = await ProbeCertificateExpiryAsync(server, options.EffectivePort, ct);
                var info = ReadDcInfo();
                log.LogInformation("Connected to {Server} ({Protocol}, {Auth})", server, options.Protocol, options.Auth);
                return info;
            }
            catch (DirectoryException ex)
            {
                last = ex;
                _connection?.Dispose();
                _connection = null;
                // A rejected password will be rejected by every DC: do not hammer the others (lockout).
                if (ex.Kind == DirectoryErrorKind.BindFailed) throw;
                log.LogWarning("Cannot use {Server}: {Reason}. Trying the next DC.", server, ex.Message);
            }
        }
        throw last ?? new DirectoryException(DirectoryErrorKind.Unreachable, "No LDAP server is configured.");
    }

    private LdapConnection Open(string server)
    {
        // A DC given by IP address works too (Negotiate then uses NTLM: Kerberos needs the host name).
        var isAddress = IPAddress.TryParse(server, out _);
        var identifier = new LdapDirectoryIdentifier(server, options.EffectivePort, fullyQualifiedDnsHostName: !isAddress, connectionless: false);
        var c = new LdapConnection(identifier) { Timeout = Timeout, AutoBind = false };
        c.SessionOptions.ProtocolVersion = 3;
        c.SessionOptions.ReferralChasing = ReferralChasingOptions.None;
        if (options.SkipCertificateValidation) c.SessionOptions.VerifyServerCertificate = (_, _) => true;

        try
        {
            switch (options.Protocol)
            {
                case LdapProtocol.Ldaps:
                    c.SessionOptions.SecureSocketLayer = true;
                    break;
                case LdapProtocol.StartTls:
                    c.SessionOptions.StartTransportLayerSecurity(null);
                    break;
                case LdapProtocol.Ldap when options.Auth == LdapAuth.Negotiate:
                    // No TLS: let Kerberos sign and encrypt the whole session.
                    c.SessionOptions.Signing = true;
                    c.SessionOptions.Sealing = true;
                    break;
                case LdapProtocol.Ldap:
                    log.LogWarning("LDAP without TLS and with a simple bind: the password and recovery keys travel unencrypted (AllowInsecure).");
                    break;
            }

            c.AuthType = options.Auth == LdapAuth.Basic ? AuthType.Basic : AuthType.Negotiate;
            var credential = BuildCredential();
            if (credential is null) c.Bind(); // the service account (gMSA)
            else c.Bind(credential);
            return c;
        }
        catch (LdapException ex)
        {
            c.Dispose();
            throw Map(ex, server);
        }
        catch (DirectoryOperationException ex)
        {
            c.Dispose();
            throw new DirectoryException(DirectoryErrorKind.TlsFailed, $"{server}: {ex.Message}", ex);
        }
    }

    private NetworkCredential? BuildCredential()
    {
        if (string.IsNullOrWhiteSpace(options.Username)) return null;
        var password = SecretProtector.Reveal(options.Password) ?? "";
        var user = options.Username!;
        var slash = user.IndexOf('\\');
        return slash > 0 && options.Auth == LdapAuth.Negotiate
            ? new NetworkCredential(user[(slash + 1)..], password, user[..slash])
            : new NetworkCredential(user, password);
    }

    private DirectoryException Map(LdapException ex, string server)
    {
        // https://learn.microsoft.com/windows/win32/api/winldap/ - LDAP_* result codes
        var kind = ex.ErrorCode switch
        {
            49 => DirectoryErrorKind.BindFailed,      // LDAP_INVALID_CREDENTIALS
            85 => DirectoryErrorKind.Timeout,         // LDAP_TIMEOUT
            81 or 91 => options.Protocol == LdapProtocol.Ldap
                ? DirectoryErrorKind.Unreachable      // LDAP_SERVER_DOWN / CONNECT_ERROR
                : DirectoryErrorKind.TlsFailed,       // the port answered (checked first), so TLS failed
            _ => DirectoryErrorKind.Other,
        };
        return new DirectoryException(kind, $"{server}: {ex.Message} (LDAP {ex.ErrorCode})", ex);
    }

    public DcInfo ReadDcInfo()
    {
        var rootDse = SendSearch(new SearchRequest("", "(objectClass=*)", SearchScope.Base,
            "highestCommittedUSN", "dnsHostName", "dsServiceName")).Entries.Cast<SearchResultEntry>().Single();
        var usn = long.Parse(GetString(rootDse, "highestCommittedUSN") ?? "0");
        var host = GetString(rootDse, "dnsHostName") ?? _server;

        // invocationId lives on the DC's NTDS Settings object; it changes when the DC is restored from backup.
        Guid? invocationId = null;
        var ntds = GetString(rootDse, "dsServiceName");
        if (ntds is not null)
        {
            var settings = SendSearch(new SearchRequest(ntds, "(objectClass=*)", SearchScope.Base, "invocationId"));
            if (settings.Entries.Count == 1 && GetBytes(settings.Entries[0], "invocationId") is { } bytes)
                invocationId = LdapValues.ParseGuid(bytes);
        }
        return new DcInfo(host, usn, invocationId, _certificateExpiresAt);
    }

    public IEnumerable<AdComputer> ReadComputers(long? sinceUsn, CancellationToken ct)
    {
        var computers = LdapValues.ComputerFilter(options.ExcludeOperatingSystems);
        var filter = sinceUsn is { } usn
            ? $"(&{computers}(uSNChanged>={usn + 1}))"
            : computers;
        foreach (var searchBase in options.EffectiveSearchBases)
        {
            var count = 0;
            foreach (var e in PagedSearch(searchBase, filter, ComputerAttributes, ct))
            {
                var computer = ToComputer(e);
                if (computer is null) continue;
                count++;
                yield return computer;
            }
            log.LogInformation("Read {Count} computers from {SearchBase}", count, searchBase);
        }
    }

    /// <summary>
    /// DNs (lower case) of the computers left out by ExcludeOperatingSystems, in every search base. Read in
    /// full even in a delta run: a changed key may belong to an unchanged excluded server.
    /// </summary>
    private HashSet<string>? ExcludedComputerDns(CancellationToken ct)
    {
        var patterns = LdapValues.CleanOsPatterns(options.ExcludeOperatingSystems);
        if (patterns.Count == 0) return null;
        var set = new HashSet<string>(StringComparer.Ordinal);
        var filter = LdapValues.ExcludedComputerFilter(patterns);
        foreach (var searchBase in options.EffectiveSearchBases)
            foreach (var e in PagedSearch(searchBase, filter, ["distinguishedName"], ct))
                set.Add(e.DistinguishedName.ToLowerInvariant());
        log.LogInformation("Leaving out {Count} computers whose operating system matches {Patterns} (and their recovery keys)", set.Count, string.Join(", ", patterns));
        return set;
    }

    public IEnumerable<AdRecoveryKey> ReadRecoveryKeys(long? sinceUsn, CancellationToken ct)
    {
        var filter = sinceUsn is { } usn
            ? $"(&(objectClass=msFVE-RecoveryInformation)(uSNChanged>={usn + 1}))"
            : "(objectClass=msFVE-RecoveryInformation)";
        var excluded = ExcludedComputerDns(ct);
        foreach (var searchBase in options.EffectiveSearchBases)
        {
            var count = 0;
            foreach (var e in PagedSearch(searchBase, filter, KeyAttributes, ct))
            {
                if (LdapValues.IsKeyOfExcluded(excluded, e.DistinguishedName)) continue;
                var guid = GetBytes(e, "msFVE-RecoveryGuid");
                var created = LdapValues.ParseGeneralizedTime(GetString(e, "whenCreated"));
                if (guid is null || created is null)
                {
                    log.LogWarning("Skipping a recovery object without msFVE-RecoveryGuid or whenCreated: {Dn}", e.DistinguishedName);
                    continue;
                }
                count++;
                yield return new AdRecoveryKey(
                    LdapValues.ParseGuid(guid),
                    e.DistinguishedName,
                    // Missing when the confidential attribute cannot be read: sent as "" (the server counts it).
                    GetString(e, "msFVE-RecoveryPassword") ?? "",
                    created.Value,
                    long.Parse(GetString(e, "uSNChanged") ?? "0"),
                    GetBytes(e, "msFVE-VolumeGuid") is { Length: 16 } volume ? LdapValues.ParseGuid(volume) : null);
            }
            log.LogInformation("Read {Count} recovery keys from {SearchBase}", count, searchBase);
        }
    }

    /// <summary>
    /// For `check`: can each configured OU be read? Reads up to <paramref name="sample"/> computers and
    /// keys per OU and counts keys whose password is not readable. Never stops at the first bad OU.
    /// </summary>
    public IReadOnlyList<SearchBaseProbe> ProbeSearchBases(int sample, CancellationToken ct)
    {
        var results = new List<SearchBaseProbe>();
        foreach (var searchBase in options.EffectiveSearchBases)
        {
            try
            {
                var computers = PagedSearch(searchBase, LdapValues.ComputerFilter(options.ExcludeOperatingSystems), ComputerAttributes, ct).Take(sample).Count();
                var keys = PagedSearch(searchBase, "(objectClass=msFVE-RecoveryInformation)", KeyAttributes, ct).Take(sample).ToList();
                results.Add(new SearchBaseProbe(searchBase, computers, keys.Count,
                    keys.Count(k => GetString(k, "msFVE-RecoveryPassword") is null), null));
            }
            catch (DirectoryException ex)
            {
                results.Add(new SearchBaseProbe(searchBase, 0, 0, 0, ex.Message));
            }
        }
        return results;
    }

    public AdComputer? ReadComputer(string dn)
    {
        try
        {
            var r = SendSearch(new SearchRequest(dn, "(objectCategory=computer)", SearchScope.Base, ComputerAttributes));
            return r.Entries.Count == 1 ? ToComputer(r.Entries[0]) : null;
        }
        catch (DirectoryException ex) when (ex.InnerException is DirectoryOperationException { Response.ResultCode: ResultCode.NoSuchObject })
        {
            return null;
        }
    }

    private AdComputer? ToComputer(SearchResultEntry e)
    {
        var guid = GetBytes(e, "objectGUID");
        var name = GetString(e, "name");
        if (guid is null || name is null) return null;
        return new AdComputer(
            LdapValues.ParseGuid(guid),
            name,
            GetString(e, "dNSHostName"),
            e.DistinguishedName,
            GetString(e, "operatingSystem"),
            long.Parse(GetString(e, "uSNChanged") ?? "0"),
            LdapValues.ParseGeneralizedTime(GetString(e, "whenChanged")),
            LdapValues.ParseGeneralizedTime(GetString(e, "whenCreated")),
            LdapValues.ParseFileTime(GetString(e, "lastLogonTimestamp")));
    }

    private IEnumerable<SearchResultEntry> PagedSearch(string searchBase, string filter, string[] attributes, CancellationToken ct)
    {
        var request = new SearchRequest(searchBase, filter, SearchScope.Subtree, attributes);
        var paging = new PageResultRequestControl(options.PageSize) { IsCritical = false };
        request.Controls.Add(paging);
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            SearchResponse response;
            try
            {
                response = SendSearch(request);
            }
            catch (DirectoryException ex) when (ex.InnerException is DirectoryOperationException
                { Response.ResultCode: ResultCode.NoSuchObject or ResultCode.InsufficientAccessRights or ResultCode.Referral })
            {
                // Skipping the OU would make a full run flag all its computers "not in AD": stop instead.
                var code = ((DirectoryOperationException)ex.InnerException!).Response.ResultCode;
                throw new DirectoryException(DirectoryErrorKind.SearchBaseFailed,
                    $"{_server}: the OU {searchBase} cannot be read ({code}). Check Ldap:SearchBases and the account's permissions.", ex);
            }
            foreach (SearchResultEntry entry in response.Entries) yield return entry;
            var page = response.Controls.OfType<PageResultResponseControl>().FirstOrDefault();
            if (page is null || page.Cookie.Length == 0) yield break;
            paging.Cookie = page.Cookie;
        }
    }

    private SearchResponse SendSearch(SearchRequest request)
    {
        try
        {
            return (SearchResponse)Connection.SendRequest(request, Timeout);
        }
        catch (LdapException ex)
        {
            throw Map(ex, _server);
        }
        catch (DirectoryOperationException ex)
        {
            throw new DirectoryException(DirectoryErrorKind.Other, $"{_server}: search of {request.DistinguishedName} failed: {ex.Message}", ex);
        }
    }

    private static string? GetString(SearchResultEntry e, string name) =>
        e.Attributes[name] is { Count: > 0 } a ? a.GetValues(typeof(string))[0] as string : null;

    private static byte[]? GetBytes(SearchResultEntry e, string name) =>
        e.Attributes[name] is { Count: > 0 } a ? a.GetValues(typeof(byte[]))[0] as byte[] : null;

    private async Task<bool> CanReachAsync(string server, CancellationToken ct)
    {
        using var tcp = new TcpClient();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Min(options.TimeoutSeconds, 10)));
        try
        {
            await tcp.ConnectAsync(server, options.EffectivePort, timeout.Token);
            return true;
        }
        catch (Exception ex) when (ex is SocketException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            return false;
        }
    }

    /// <summary>Expiry of the DC's LDAPS certificate (for the heartbeat), without failing the run.</summary>
    private async Task<DateTimeOffset?> ProbeCertificateExpiryAsync(string server, int port, CancellationToken ct)
    {
        try
        {
            using var tcp = new TcpClient();
            await tcp.ConnectAsync(server, port, ct);
            DateTimeOffset? notAfter = null;
            await using var ssl = new SslStream(tcp.GetStream(), false, (_, cert, _, _) =>
            {
                if (cert is not null) notAfter = new DateTimeOffset(new X509Certificate2(cert).NotAfter.ToUniversalTime());
                return true; // only reading the date; the LDAP connection itself validates the certificate
            });
            await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions { TargetHost = server }, ct);
            return notAfter;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogDebug(ex, "Could not read the LDAPS certificate of {Server}", server);
            return null;
        }
    }

    public void Dispose() => _connection?.Dispose();
}

using Microsoft.Extensions.Options;

namespace BitlockerSync.Worker.Options;

/// <summary>Rules that need more than attributes; checked at startup so a bad config never runs.</summary>
public sealed class LdapOptionsValidator : IValidateOptions<LdapOptions>
{
    public ValidateOptionsResult Validate(string? name, LdapOptions o)
    {
        var errors = new List<string>();
        if (o.Source == DirectorySource.JsonFile)
        {
            if (string.IsNullOrWhiteSpace(o.JsonFilePath)) errors.Add("Ldap:JsonFilePath is required when Source is JsonFile.");
            return errors.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(errors);
        }

        if (o.Servers.Count == 0) errors.Add("Ldap:Servers needs at least one domain controller.");
        if (string.IsNullOrWhiteSpace(o.BaseDn)) errors.Add("Ldap:BaseDn is required (e.g. DC=corp,DC=local).");
        else
        {
            foreach (var sb in o.SearchBases.Where(b => !string.IsNullOrWhiteSpace(b) && !Directory.LdapValues.IsWithin(b, o.BaseDn)))
                errors.Add($"Ldap:SearchBases: \"{sb}\" is not inside Ldap:BaseDn ({o.BaseDn}).");
        }

        var excludeOs = Directory.LdapValues.CleanOsPatterns(o.ExcludeOperatingSystems);
        if (excludeOs.Count > 50) errors.Add("Ldap:ExcludeOperatingSystems has too many entries (at most 50).");
        foreach (var p in excludeOs.Where(p => p.Length > 128 || p.IndexOfAny(['\0', '\r', '\n']) >= 0 || p.Trim('*').Length == 0))
            errors.Add($"Ldap:ExcludeOperatingSystems: \"{p}\" is not a valid pattern (text up to 128 characters, not only \"*\").");

        var hasUser = !string.IsNullOrWhiteSpace(o.Username);
        var hasPassword = !string.IsNullOrEmpty(o.Password);
        if (o.Auth == LdapAuth.Basic && (!hasUser || !hasPassword))
            errors.Add("Ldap:Auth = Basic needs Ldap:Username and Ldap:Password.");
        if (o.Auth == LdapAuth.Negotiate && hasUser != hasPassword)
            errors.Add("Ldap:Username and Ldap:Password go together (or leave both empty to use the service account).");

        // A simple bind over plain LDAP sends the password, and then every recovery key, in clear text.
        if (o.Protocol == LdapProtocol.Ldap && o.Auth == LdapAuth.Basic && !o.AllowInsecure)
            errors.Add("Ldap:Protocol = Ldap with Auth = Basic sends the password and recovery keys unencrypted. " +
                       "Use Ldaps or StartTls, or Negotiate; set Ldap:AllowInsecure = true only in a lab.");

        return errors.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(errors);
    }
}

public sealed class IngestOptionsValidator : IValidateOptions<IngestOptions>
{
    public ValidateOptionsResult Validate(string? name, IngestOptions o)
    {
        var errors = new List<string>();
        if (!Uri.TryCreate(o.BaseUrl, UriKind.Absolute, out var uri))
        {
            errors.Add("Ingest:BaseUrl must be an absolute URL, e.g. https://blk.corp.local:8443/api/ingest.");
        }
        else if (uri.Scheme == Uri.UriSchemeHttp && !uri.IsLoopback)
        {
            errors.Add("Ingest:BaseUrl must use https (plain http is accepted for localhost only).");
        }
        if (string.IsNullOrWhiteSpace(o.ApiKey) && uri is { IsLoopback: false })
            errors.Add("Ingest:ApiKey is required (INGEST_API_KEY of the server).");
        return errors.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(errors);
    }
}

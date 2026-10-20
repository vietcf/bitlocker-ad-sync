using BitlockerSync.Worker.Directory;
using BitlockerSync.Worker.Ingest;
using BitlockerSync.Worker.Options;
using BitlockerSync.Worker.Sync;

namespace BitlockerSync.Tests;

public class LdapValuesTests
{
    [Theory]
    [InlineData("20261012081355.0Z", "2026-10-12T08:13:55+00:00")]
    [InlineData("20261012081355Z", "2026-10-12T08:13:55+00:00")]
    public void Parses_ad_generalized_time_as_utc(string value, string expected) =>
        Assert.Equal(DateTimeOffset.Parse(expected), LdapValues.ParseGeneralizedTime(value));

    [Fact]
    public void Returns_null_for_unparsable_time() => Assert.Null(LdapValues.ParseGeneralizedTime("yesterday"));

    [Fact]
    public void Parses_ad_file_time_for_last_logon()
    {
        var expected = new DateTimeOffset(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);
        Assert.Equal(expected, LdapValues.ParseFileTime(expected.ToFileTime().ToString()));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("9223372036854775807")]
    [InlineData("abc")]
    public void File_time_without_a_value_is_null(string? value) => Assert.Null(LdapValues.ParseFileTime(value));

    [Fact]
    public void Converts_ad_binary_guids_like_the_rest_of_windows()
    {
        // {01234567-89AB-CDEF-0123-456789ABCDEF} is stored as 67 45 23 01 AB 89 EF CD 01 23 45 67 89 AB CD EF.
        var bytes = Convert.FromHexString("67452301AB89EFCD0123456789ABCDEF");
        Assert.Equal(Guid.Parse("01234567-89ab-cdef-0123-456789abcdef"), LdapValues.ParseGuid(bytes));
    }

    [Theory]
    [InlineData("CN={GUID},CN=HN-LT-0231,OU=Laptops,DC=corp,DC=local", "CN=HN-LT-0231,OU=Laptops,DC=corp,DC=local")]
    [InlineData(@"CN=Nguyen\, Van A,OU=Users,DC=corp", "OU=Users,DC=corp")]
    [InlineData("DC=local", "")]
    public void Finds_the_parent_dn(string dn, string parent) => Assert.Equal(parent, LdapValues.ParentDn(dn));

    [Fact]
    public void Computer_filter_leaves_out_the_chosen_operating_systems()
    {
        Assert.Equal("(objectCategory=computer)", LdapValues.ComputerFilter(null));
        Assert.Equal("(objectCategory=computer)", LdapValues.ComputerFilter([" ", ""]));
        Assert.Equal(
            "(&(objectCategory=computer)(!(operatingSystem=Windows Server*))(!(operatingSystem=Linux \\28x\\29)))",
            LdapValues.ComputerFilter([" Windows Server* ", "windows server*", "", "Linux (x)"]));
        Assert.Equal(
            "(&(objectCategory=computer)(|(operatingSystem=Windows Server*)(operatingSystem=Ubuntu*)))",
            LdapValues.ExcludedComputerFilter(["Windows Server*", "Ubuntu*"]));
    }

    [Fact]
    public void Pattern_escaping_keeps_the_wildcard() =>
        Assert.Equal(@"Win*dows \28R\29\5cx", LdapValues.EscapeFilterPattern(@"Win*dows (R)\x"));

    [Fact]
    public void Keys_of_excluded_computers_are_recognised()
    {
        var excluded = new HashSet<string> { "cn=srv01,ou=servers,dc=corp,dc=local" };
        Assert.True(LdapValues.IsKeyOfExcluded(excluded, "CN=2026-10-18T10:00:00+07:00{ABCDEF},CN=SRV01,OU=Servers,DC=corp,DC=local"));
        Assert.False(LdapValues.IsKeyOfExcluded(excluded, "CN=2026{X},CN=HN-LT-01,OU=Computers,DC=corp,DC=local"));
        Assert.False(LdapValues.IsKeyOfExcluded(null, "CN=2026{X},CN=SRV01,OU=Servers,DC=corp,DC=local"));
    }

    [Fact]
    public void Escapes_ldap_filter_values() => Assert.Equal(@"a\2a\28b\29\5c", LdapValues.EscapeFilterValue(@"a*(b)\"));
}

public class RedactionTests
{
    private const string Password = "123456-234567-345678-456789-567890-678901-789012-890123";

    [Fact]
    public void Directory_key_never_prints_its_password()
    {
        var k = new AdRecoveryKey(Guid.NewGuid(), "CN=x", Password, DateTimeOffset.UtcNow, 1);
        Assert.DoesNotContain(Password, k.ToString());
        Assert.Contains("[REDACTED]", k.ToString());
    }

    [Fact]
    public void Api_key_item_never_prints_its_password()
    {
        var k = new KeyItem(Guid.NewGuid().ToString(), "CN=x", Password, DateTimeOffset.UtcNow, Guid.NewGuid().ToString());
        Assert.DoesNotContain(Password, k.ToString());
        Assert.DoesNotContain(Password, new KeysBatch(1, [k]).ToString());
    }

    [Fact]
    public void Key_item_carries_the_volume_guid_as_volumeGuid()
    {
        var volume = Guid.NewGuid();
        var item = SyncRunner.ToItem(new AdRecoveryKey(Guid.NewGuid(), "CN=x", Password, DateTimeOffset.UtcNow, 1, volume));
        var json = System.Text.Json.JsonSerializer.Serialize(item, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
        Assert.Contains($"\"volumeGuid\":\"{volume}\"", json);
        Assert.Null(SyncRunner.ToItem(new AdRecoveryKey(Guid.NewGuid(), "CN=x", Password, DateTimeOffset.UtcNow, 1)).VolumeGuid);
    }
}

public class OptionsValidatorTests
{
    private static LdapOptions Ldap(Action<LdapOptions> change)
    {
        var o = new LdapOptions { Servers = ["dc01.corp.local"], BaseDn = "DC=corp,DC=local" };
        change(o);
        return o;
    }

    private static bool Valid(LdapOptions o) => new LdapOptionsValidator().Validate(null, o).Succeeded;

    [Fact]
    public void Accepts_ldaps_with_the_service_account() => Assert.True(Valid(Ldap(_ => { })));

    [Fact]
    public void Validates_the_optional_operating_system_exclusions()
    {
        Assert.True(Valid(Ldap(o => o.ExcludeOperatingSystems = ["Windows Server*", "  ", "ubuntu*"])));
        Assert.False(Valid(Ldap(o => o.ExcludeOperatingSystems = ["*"])));
        Assert.False(Valid(Ldap(o => o.ExcludeOperatingSystems = [new string('a', 129)])));
        Assert.False(Valid(Ldap(o => o.ExcludeOperatingSystems = Enumerable.Range(0, 51).Select(i => "os" + i).ToList())));
    }

    [Fact]
    public void Accepts_ldaps_or_starttls_with_username_and_password()
    {
        Assert.True(Valid(Ldap(o => { o.Auth = LdapAuth.Basic; o.Username = "svc@corp.local"; o.Password = "x"; })));
        Assert.True(Valid(Ldap(o => { o.Protocol = LdapProtocol.StartTls; o.Auth = LdapAuth.Basic; o.Username = "svc@corp.local"; o.Password = "x"; })));
    }

    [Fact]
    public void Refuses_a_simple_bind_over_plain_ldap_unless_explicitly_allowed()
    {
        var insecure = Ldap(o => { o.Protocol = LdapProtocol.Ldap; o.Auth = LdapAuth.Basic; o.Username = "svc@corp.local"; o.Password = "x"; });
        Assert.False(Valid(insecure));
        insecure.AllowInsecure = true;
        Assert.True(Valid(insecure));
    }

    [Fact]
    public void Accepts_plain_ldap_with_negotiate_because_kerberos_seals_it() =>
        Assert.True(Valid(Ldap(o => o.Protocol = LdapProtocol.Ldap)));

    [Fact]
    public void Requires_both_username_and_password()
    {
        Assert.False(Valid(Ldap(o => { o.Auth = LdapAuth.Basic; o.Username = "svc"; })));
        Assert.False(Valid(Ldap(o => o.Username = "CORP\\svc")));
    }

    [Fact]
    public void Requires_servers_and_base_dn() => Assert.False(Valid(new LdapOptions()));

    [Theory]
    [InlineData("http://localhost:8443/api/ingest", null, true)]
    [InlineData("http://blk.corp.local:8443/api/ingest", "key", false)]
    [InlineData("https://blk.corp.local:8443/api/ingest", null, false)]
    [InlineData("https://blk.corp.local:8443/api/ingest", "a-key", true)]
    public void Ingest_needs_https_and_credentials_outside_localhost(string url, string? apiKey, bool ok) =>
        Assert.Equal(ok, new IngestOptionsValidator().Validate(null, new IngestOptions { BaseUrl = url, ApiKey = apiKey }).Succeeded);
}

public class SyncStateStoreTests
{
    [Fact]
    public void Saves_and_loads_with_a_relative_or_absolute_path()
    {
        foreach (var file in new[] { $"state-test-{Guid.NewGuid():N}.json", Path.Combine(Path.GetTempPath(), $"blk-{Guid.NewGuid():N}", "state.json") })
        {
            var store = new BitlockerSync.Worker.Sync.SyncStateStore(Microsoft.Extensions.Options.Options.Create(new ScheduleOptions { StateFile = file }));
            var state = new BitlockerSync.Worker.Sync.SyncState("dc01", Guid.NewGuid(), new DateOnly(2026, 10, 13));
            store.Save(state);
            Assert.Equal(state, store.Load());
            File.Delete(Path.GetFullPath(file, AppContext.BaseDirectory));
        }
    }
}

public class SearchBaseTests
{
    private const string Base = "DC=corp,DC=local";

    [Fact]
    public void Empty_list_means_the_whole_domain() =>
        Assert.Equal([Base], LdapValues.EffectiveSearchBases([], Base));

    [Fact]
    public void Keeps_the_configured_order_and_drops_duplicates_and_nested_ous()
    {
        var bases = LdapValues.EffectiveSearchBases(
        [
            "OU=Computers,OU=HN,DC=corp,DC=local",
            "OU=Laptops, OU=Computers,OU=HN,DC=corp,DC=local", // inside the first: already covered
            "OU=Computers,OU=HCM,DC=corp,DC=local",
            "ou=computers,ou=hcm,dc=corp,dc=local",            // same OU, other spelling
            "  ",
        ], Base);
        Assert.Equal(["OU=Computers,OU=HN,DC=corp,DC=local", "OU=Computers,OU=HCM,DC=corp,DC=local"], bases);
    }

    [Fact]
    public void Refuses_an_ou_outside_the_base_dn()
    {
        var o = new LdapOptions
        {
            Servers = ["dc01.corp.local"], BaseDn = Base,
            SearchBases = ["OU=Computers,OU=HN,DC=corp,DC=local", "OU=Computers,DC=other,DC=local"],
        };
        var result = new LdapOptionsValidator().Validate(null, o);
        Assert.False(result.Succeeded);
        Assert.Contains("OU=Computers,DC=other,DC=local", result.FailureMessage);
    }

    [Fact]
    public void An_unreadable_ou_has_its_own_error_code() =>
        Assert.Equal("ldap_search_base_failed", new DirectoryException(DirectoryErrorKind.SearchBaseFailed, "x").ApiErrorCode);
}

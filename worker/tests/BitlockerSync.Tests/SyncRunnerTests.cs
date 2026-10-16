using BitlockerSync.Worker.Directory;
using BitlockerSync.Worker.Options;
using BitlockerSync.Worker.Sync;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace BitlockerSync.Tests;

public class SyncRunnerTests
{
    private readonly FakeDirectory _ad = new();
    private readonly FakeIngestApi _api = new();
    private readonly MemoryStateStore _state = new();
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 13, 2, 0, 0, TimeSpan.Zero));

    private SyncRunner Runner(int batchSize = 500) => new(
        _ad, _api, _state,
        Microsoft.Extensions.Options.Options.Create(new IngestOptions { BaseUrl = "http://localhost", BatchSize = batchSize }),
        _time, NullLogger<SyncRunner>.Instance);

    [Fact]
    public async Task Full_run_sends_all_computers_before_keys_in_batches_and_reports_the_snapshot_usn()
    {
        for (var i = 0; i < 5; i++) _ad.AddKey(_ad.AddComputer(i));
        _ad.Dc = _ad.Dc with { HighestCommittedUsn = 4242 };

        var outcome = await Runner(batchSize: 2).RunAsync(SyncMode.Full, CancellationToken.None);

        Assert.Equal("success", outcome.Status);
        Assert.Equal([2, 2, 1], _api.ComputerBatchSizes);
        Assert.True(_api.Calls.LastIndexOf("computers") < _api.Calls.IndexOf("keys"), "computers must be sent before keys");
        var done = Assert.Single(_api.Completed);
        Assert.Equal(4242, done.HighestUsn);
        Assert.Equal(5, done.ComputersSeen);
        Assert.Equal(5, done.KeysSeen);
        Assert.Equal(0, done.Errors);
        Assert.Equal(DateOnly.FromDateTime(_time.GetLocalNow().DateTime), _state.State.LastFullDate);
    }

    [Fact]
    public async Task Delta_reads_only_objects_changed_after_the_servers_since_usn()
    {
        _ad.AddComputer(1, usn: 50);
        var changed = _ad.AddComputer(2, usn: 150);
        _api.LastRun = new(1, "dc01.corp.local", 100, DateTimeOffset.UtcNow);
        _api.KnownComputerDns.Add(_ad.Computers[0].Dn);

        var outcome = await Runner().RunAsync(SyncMode.Delta, CancellationToken.None);

        Assert.Equal(SyncMode.Delta, outcome.Mode);
        Assert.Equal(100, _ad.ComputerQueries.Single());
        Assert.Equal(1, outcome.ComputersSent);
        Assert.Contains(changed.Dn, _api.KnownComputerDns);
    }

    [Fact]
    public async Task Follows_the_server_when_it_turns_a_delta_into_a_full_run()
    {
        _api.ForcedMode = "full";
        _ad.AddComputer(1);
        var outcome = await Runner().RunAsync(SyncMode.Delta, CancellationToken.None);
        Assert.Equal(SyncMode.Full, outcome.Mode);
        Assert.Null(_ad.ComputerQueries.Single());
    }

    [Fact]
    public async Task Sends_the_parent_computer_of_an_orphan_key_and_the_key_again_in_the_same_run()
    {
        var known = _ad.AddComputer(1, usn: 50);       // not in this delta
        var newPc = _ad.AddComputer(2, usn: 50);       // also not in this delta, unknown to the server
        _ad.AddKey(known, usn: 150);
        _ad.AddKey(newPc, usn: 150);                   // its computer is unknown -> orphan
        _api.KnownComputerDns.Add(known.Dn);

        var outcome = await Runner().RunAsync(SyncMode.Delta, CancellationToken.None);

        Assert.Equal(0, outcome.OrphansLeft);
        Assert.Contains(newPc.Dn, _api.KnownComputerDns);
        var done = Assert.Single(_api.Completed);
        Assert.Equal(_ad.Dc.HighestCommittedUsn, done.HighestUsn);
        Assert.Equal(0, done.Errors);
    }

    [Fact]
    public async Task Keeps_the_old_usn_when_orphan_keys_remain_so_the_next_delta_reads_them_again()
    {
        var pc = _ad.AddComputer(1, usn: 50);
        _ad.AddKey(pc, usn: 150);
        _api.NeverKnownDns.Add(pc.Dn);                 // the server never accepts this computer

        var outcome = await Runner().RunAsync(SyncMode.Delta, CancellationToken.None);

        Assert.Equal(1, outcome.OrphansLeft);
        var done = Assert.Single(_api.Completed);
        Assert.Equal(_api.SinceUsn, done.HighestUsn);
        Assert.Equal(1, done.Errors);
    }

    [Fact]
    public async Task Runs_full_when_the_dc_was_restored_new_invocation_id()
    {
        _state.State = new SyncState("dc01.corp.local", Guid.NewGuid(), null);
        await Runner().RunAsync(SyncMode.Delta, CancellationToken.None);
        Assert.Equal("full", _api.Opened.Single().Mode);
    }

    [Fact]
    public async Task Runs_full_when_the_dc_usn_went_back()
    {
        _api.LastRun = new(7, "dc01.corp.local", 999_999, DateTimeOffset.UtcNow);
        await Runner().RunAsync(SyncMode.Delta, CancellationToken.None);
        Assert.Equal("full", _api.Opened.Single().Mode);
    }

    [Fact]
    public async Task Closes_the_run_as_cancelled_when_the_service_stops_mid_run()
    {
        _ad.AddKey(_ad.AddComputer(1));
        using var stop = new CancellationTokenSource();
        _api.StopWhileSendingKeys = stop;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Runner().RunAsync(SyncMode.Full, stop.Token));

        var done = Assert.Single(_api.Completed);
        Assert.Equal("failed", done.Status);
        Assert.Equal("cancelled", done.ErrorCode);
        Assert.Null(_state.State.LastFullDate);
    }

    [Fact]
    public async Task Reports_a_failed_run_with_the_ldap_error_code_when_ad_cannot_be_read()
    {
        _ad.ConnectError = new DirectoryException(DirectoryErrorKind.BindFailed, "invalid credentials");

        var outcome = await Runner().RunAsync(SyncMode.Delta, CancellationToken.None);

        Assert.Equal("failed", outcome.Status);
        Assert.False(outcome.LdapOk);
        var done = Assert.Single(_api.Completed);
        Assert.Equal("failed", done.Status);
        Assert.Equal("ldap_bind_failed", done.ErrorCode);
        Assert.DoesNotContain("computers", _api.Calls);
    }

    [Fact]
    public async Task Sends_keys_with_an_unreadable_password_as_empty_strings()
    {
        var pc = _ad.AddComputer(1);
        _ad.AddKey(pc, password: "");
        var outcome = await Runner().RunAsync(SyncMode.Full, CancellationToken.None);
        Assert.Equal(1, outcome.KeysSent);
    }

    [Fact]
    public async Task Sends_every_key_with_the_object_guid_of_its_computer()
    {
        var inRun = _ad.AddComputer(1, usn: 150);     // read in this delta
        var notInRun = _ad.AddComputer(2, usn: 50);   // unchanged: read from AD for its key
        _api.KnownComputerDns.Add(notInRun.Dn);
        var k1 = _ad.AddKey(inRun, usn: 160);
        var k2 = _ad.AddKey(notInRun, usn: 160);

        await Runner().RunAsync(SyncMode.Delta, CancellationToken.None);

        var byKey = _api.SentKeys.ToDictionary(k => k.KeyId, k => k.ComputerObjectGuid);
        Assert.Equal(inRun.ObjectGuid.ToString(), byKey[k1.KeyId.ToString()]);
        Assert.Equal(notInRun.ObjectGuid.ToString(), byKey[k2.KeyId.ToString()]);
    }
}

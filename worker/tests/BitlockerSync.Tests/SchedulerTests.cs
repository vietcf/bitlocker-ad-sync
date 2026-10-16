using BitlockerSync.Worker.Options;
using BitlockerSync.Worker.Scheduling;
using BitlockerSync.Worker.Sync;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace BitlockerSync.Tests;

public class SchedulerTests
{
    private readonly FakeDirectory _ad = new();
    private readonly FakeIngestApi _api = new();
    private readonly MemoryStateStore _state = new();
    // 10:00 local time (UTC in the test process is fine: the scheduler only compares local times).
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 13, 10, 0, 0, TimeSpan.Zero)) { };

    private SyncScheduler Make()
    {
        _time.SetLocalTimeZone(TimeZoneInfo.Utc);
        var runner = new SyncRunner(_ad, _api, _state,
            Microsoft.Extensions.Options.Options.Create(new IngestOptions { BaseUrl = "http://localhost" }), _time, NullLogger<SyncRunner>.Instance);
        return new SyncScheduler(runner, _api, _state,
            Microsoft.Extensions.Options.Options.Create(new ScheduleOptions { DeltaEveryMinutes = 15, HeartbeatEveryMinutes = 5, FullAt = "01:00", WorkerId = "w1" }),
            _time, NullLogger<SyncScheduler>.Instance);
    }

    private string LastMode => _api.Opened.Last().Mode;

    [Fact]
    public async Task Runs_a_full_sync_at_first_start_then_deltas()
    {
        var s = Make();
        await s.StepAsync(CancellationToken.None);
        Assert.Equal("full", LastMode);
        Assert.Equal("heartbeat", _api.Calls[0]);

        _time.Advance(TimeSpan.FromMinutes(16));
        await s.StepAsync(CancellationToken.None);
        Assert.Equal("delta", LastMode);
    }

    [Fact]
    public async Task Waits_for_the_delta_interval_between_runs()
    {
        var s = Make();
        await s.StepAsync(CancellationToken.None);
        _time.Advance(TimeSpan.FromMinutes(5));
        await s.StepAsync(CancellationToken.None);
        Assert.Single(_api.Opened);
    }

    [Fact]
    public async Task Runs_the_nightly_full_sync_once_per_day()
    {
        _state.State = new SyncState("dc01.corp.local", _ad.Dc.InvocationId, new DateOnly(2026, 10, 12));
        var s = Make();
        await s.StepAsync(CancellationToken.None); // 10:00, full for today not done yet
        Assert.Equal("full", LastMode);
        _time.Advance(TimeSpan.FromMinutes(16));
        await s.StepAsync(CancellationToken.None);
        Assert.Equal("delta", LastMode);
    }

    [Fact]
    public async Task Starts_a_run_requested_from_the_heartbeat_right_away()
    {
        _state.State = new SyncState("dc01.corp.local", _ad.Dc.InvocationId, new DateOnly(2026, 10, 13));
        var s = Make();
        await s.StepAsync(CancellationToken.None); // delta (first pass)
        _api.SyncRequested = "full";
        _time.Advance(TimeSpan.FromMinutes(6));    // heartbeat due, delta not yet due
        await s.StepAsync(CancellationToken.None);
        Assert.Equal("full", LastMode);
    }

    [Fact]
    public async Task Reports_the_last_ldap_problem_in_the_next_heartbeat()
    {
        _ad.ConnectError = new BitlockerSync.Worker.Directory.DirectoryException(
            BitlockerSync.Worker.Directory.DirectoryErrorKind.Unreachable, "down");
        var s = Make();
        await s.StepAsync(CancellationToken.None);
        _time.Advance(TimeSpan.FromMinutes(6));
        await s.StepAsync(CancellationToken.None);
        var hb = _api.Heartbeats.Last();
        Assert.False(hb.LdapOk);
        Assert.Equal("ldap_unreachable", hb.LastErrorCode);
        Assert.Equal("w1", hb.WorkerId);
    }
}

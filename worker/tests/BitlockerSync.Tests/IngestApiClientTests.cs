using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using BitlockerSync.Worker.Ingest;
using BitlockerSync.Worker.Options;
using Microsoft.Extensions.Logging.Abstractions;

namespace BitlockerSync.Tests;

public class IngestApiClientTests
{
    /// <summary>Answers with a queue of (status, json) and records each request.</summary>
    private sealed class ScriptedHandler(params (HttpStatusCode Status, string Json)[] answers) : HttpMessageHandler
    {
        private readonly Queue<(HttpStatusCode, string)> _answers = new(answers);
        public List<HttpRequestMessage> Requests { get; } = [];
        public List<string> Bodies { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request);
            Bodies.Add(request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct));
            var (status, json) = _answers.Count > 0 ? _answers.Dequeue() : (HttpStatusCode.InternalServerError, "{}");
            return new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }

    private static (IngestApiClient Client, ScriptedHandler Handler, List<TimeSpan> Waits) Make(
        params (HttpStatusCode, string)[] answers)
    {
        var handler = new ScriptedHandler(answers);
        var waits = new List<TimeSpan>();
        var options = new IngestOptions { BaseUrl = "http://localhost:8443/api/ingest", ApiKey = "test-key", RetryForMinutes = 60 };
        var client = new IngestApiClient(new HttpClient(handler), options, NullLogger<IngestApiClient>.Instance,
            (t, _) => { waits.Add(t); return Task.CompletedTask; });
        return (client, handler, waits);
    }

    [Fact]
    public async Task Sends_camel_case_json_with_the_api_key_to_the_right_path()
    {
        var (client, handler, _) = Make((HttpStatusCode.Created, """{"runId":5,"mode":"delta","sinceUsn":42}"""));

        var r = await client.OpenRunAsync(new OpenRunRequest("delta", "dc01"), CancellationToken.None);

        Assert.Equal(new OpenRunResponse(5, "delta", 42), r);
        var req = handler.Requests.Single();
        Assert.Equal("http://localhost:8443/api/ingest/sync-runs", req.RequestUri!.ToString());
        Assert.Equal("Bearer test-key", req.Headers.Authorization!.ToString());
        Assert.Contains("\"dcName\":\"dc01\"", handler.Bodies.Single());
    }

    [Fact]
    public async Task Retries_server_errors_with_growing_waits_then_succeeds()
    {
        var (client, handler, waits) = Make(
            (HttpStatusCode.ServiceUnavailable, "{}"),
            (HttpStatusCode.InternalServerError, """{"error":"internal"}"""),
            (HttpStatusCode.OK, """{"upserted":1,"moved":0,"unmapped":0}"""));

        var r = await client.SendComputersAsync(new ComputersBatch(1, []), CancellationToken.None);

        Assert.Equal(1, r.Upserted);
        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal([TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2)], waits);
    }

    [Fact]
    public async Task Does_not_retry_client_errors_and_keeps_the_error_code()
    {
        var (client, handler, _) = Make((HttpStatusCode.Conflict, """{"error":"run_in_progress","message":"busy"}"""));

        var ex = await Assert.ThrowsAsync<IngestException>(() => client.OpenRunAsync(new OpenRunRequest("full", "dc01"), CancellationToken.None));

        Assert.Equal(409, ex.Status);
        Assert.Equal("run_in_progress", ex.Code);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Tries_a_heartbeat_only_once()
    {
        var (client, handler, _) = Make((HttpStatusCode.BadGateway, "{}"));
        await Assert.ThrowsAsync<IngestException>(() =>
            client.HeartbeatAsync(new HeartbeatRequest("w", null, null, null, null, null, null, null), CancellationToken.None));
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Reads_an_empty_last_run_as_none()
    {
        var (client, _, _) = Make((HttpStatusCode.OK, "{}"), (HttpStatusCode.OK, """{"runId":3,"dcName":"dc01","highestUsn":9,"finishedAt":"2026-10-13T01:00:00Z"}"""));
        Assert.Null(await client.GetLastRunAsync(CancellationToken.None));
        Assert.Equal(9, (await client.GetLastRunAsync(CancellationToken.None))!.HighestUsn);
    }

    [Fact]
    public async Task Never_puts_a_recovery_password_anywhere_but_the_keys_body()
    {
        const string password = "123456-234567-345678-456789-567890-678901-789012-890123";
        var (client, handler, _) = Make((HttpStatusCode.OK, """{"inserted":1,"skipped":0,"emptyPassword":0,"orphans":[]}"""));
        await client.SendKeysAsync(new KeysBatch(1, [new KeyItem(Guid.NewGuid().ToString(), "CN=x", password, DateTimeOffset.UtcNow)]), CancellationToken.None);
        var req = handler.Requests.Single();
        Assert.DoesNotContain(password, req.RequestUri!.ToString());
        Assert.DoesNotContain(password, req.Headers.ToString());
        Assert.Contains(password, handler.Bodies.Single());
    }
}

public class ServerCertificateTrustTests
{
    private static (X509Certificate2 Ca, X509Certificate2 Leaf) MakeChain(string caName)
    {
        using var caKey = System.Security.Cryptography.RSA.Create(2048);
        var caReq = new CertificateRequest($"CN={caName}", caKey, System.Security.Cryptography.HashAlgorithmName.SHA256, System.Security.Cryptography.RSASignaturePadding.Pkcs1);
        caReq.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        caReq.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        var ca = caReq.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));

        using var leafKey = System.Security.Cryptography.RSA.Create(2048);
        var leafReq = new CertificateRequest("CN=localhost", leafKey, System.Security.Cryptography.HashAlgorithmName.SHA256, System.Security.Cryptography.RSASignaturePadding.Pkcs1);
        leafReq.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        leafReq.CertificateExtensions.Add(san.Build());
        var leaf = leafReq.Create(ca, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddMonths(6), [1, 2, 3, 4]);
        return (ca, leaf);
    }

    [Fact]
    public void Trusts_a_server_certificate_issued_by_the_configured_ca()
    {
        var (ca, leaf) = MakeChain("Dev CA");
        Assert.True(IngestApiClient.TrustedBy(ca, leaf, System.Net.Security.SslPolicyErrors.RemoteCertificateChainErrors));
    }

    [Fact]
    public void Refuses_another_ca_or_a_name_mismatch()
    {
        var (_, leaf) = MakeChain("Dev CA");
        var (otherCa, _) = MakeChain("Other CA");
        Assert.False(IngestApiClient.TrustedBy(otherCa, leaf, System.Net.Security.SslPolicyErrors.RemoteCertificateChainErrors));
        var (ca, leaf2) = MakeChain("Dev CA 2");
        Assert.False(IngestApiClient.TrustedBy(ca, leaf2, System.Net.Security.SslPolicyErrors.RemoteCertificateNameMismatch));
    }
}

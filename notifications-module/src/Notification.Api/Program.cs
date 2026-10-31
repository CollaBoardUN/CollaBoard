using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CollaBoard.Notifications;
using CollaBoard.NotificationApi;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);
var cs = Environment.GetEnvironmentVariable("NOTIFICATION_DATABASE_URL")
    ?? throw new InvalidOperationException("NOTIFICATION_DATABASE_URL requerida");
var secret = Environment.GetEnvironmentVariable("JWT_SECRET")
    ?? throw new InvalidOperationException("JWT_SECRET requerida");
var serviceToken = Environment.GetEnvironmentVariable("NOTIFICATIONS_SERVICE_TOKEN")
    ?? throw new InvalidOperationException("NOTIFICATIONS_SERVICE_TOKEN requerida");
if (Encoding.UTF8.GetByteCount(secret) < 32 || Encoding.UTF8.GetByteCount(serviceToken) < 24)
    throw new InvalidOperationException("Configura secretos JWT (>=32 bytes) y de servicio (>=24 bytes)");

builder.Services.AddSingleton(new NotificationDatabase(cs));
builder.Services.AddHostedService<OutboxDispatcher>();
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
{
    o.MapInboundClaims = false;
    o.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidIssuer = "collaboard-auth",
        ValidateAudience = false,
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret)),
        ValidateLifetime = true,
        RequireExpirationTime = true,
        RequireSignedTokens = true,
        ClockSkew = TimeSpan.FromSeconds(15),
        ValidAlgorithms = new[] { SecurityAlgorithms.HmacSha256 }
    };
});
builder.Services.AddAuthorization();
var app = builder.Build();
// La DB puede empezar un instante después del proceso; Compose espera su healthcheck.
await app.Services.GetRequiredService<NotificationDatabase>().MigrateAsync(CancellationToken.None);
app.UseAuthentication();
app.UseAuthorization();

static IResult Error(int status, string detail) => Results.Json(new { detail }, statusCode: status);
static bool ServiceIsAuthenticated(HttpContext ctx, string configured)
{
    var submitted = ctx.Request.Headers["X-Service-Token"].ToString();
    var a = SHA256.HashData(Encoding.UTF8.GetBytes(submitted));
    var b = SHA256.HashData(Encoding.UTF8.GetBytes(configured));
    return submitted.Length > 0 && CryptographicOperations.FixedTimeEquals(a, b);
}

app.Use(async (ctx, next) =>
{
    var requestId = ctx.Request.Headers["X-Request-Id"].ToString();
    if (requestId.Length is < 1 or > 128) requestId = Guid.NewGuid().ToString("N");
    ctx.Response.Headers["X-Request-Id"] = requestId;
    ctx.Response.Headers["Cache-Control"] = "no-store";
    await next();
});

app.MapGet("/health", async (NotificationDatabase db, CancellationToken ct) =>
{
    try
    {
        await using var connection = await db.OpenAsync(ct);
        return Results.Ok(new { status = "ok" });
    }
    catch { return Error(503, "NotificationDB no disponible"); }
});

app.MapPost("/internal/events", async (HttpContext ctx, NotificationDatabase db, CancellationToken ct) =>
{
    if (!ServiceIsAuthenticated(ctx, serviceToken)) return Error(401, "Servicio no autorizado");
    if (ctx.Request.ContentLength > 16384) return Error(413, "Evento demasiado grande");
    NotificationEvent? item;
    try { item = await ctx.Request.ReadFromJsonAsync<NotificationEvent>(cancellationToken: ct); }
    catch (JsonException) { return Error(400, "JSON inválido"); }
    var reason = EventValidation.Error(item);
    if (reason != null) return Error(422, reason);
    try
    {
        var result = await db.AcceptEventAsync(item!, ct);
        if (result == "conflict") return Error(409, "event_id reutilizado con contenido diferente");
        return Results.Accepted(value: new { accepted = true, duplicate = result == "duplicate", event_id = item!.EventId });
    }
    catch (Exception) { return Error(503, "No se pudo guardar el evento"); }
});

app.MapGet("/api/notifications", async (ClaimsPrincipal user, NotificationDatabase db, int? limit, CancellationToken ct) =>
{
    var subject = user.FindFirstValue("sub");
    if (string.IsNullOrWhiteSpace(subject)) return Error(401, "No autenticado");
    if (limit is < 1 or > 100) return Error(422, "limit debe estar entre 1 y 100");
    try { return Results.Ok(await db.GetInboxAsync(subject, limit ?? 20, ct)); }
    catch { return Error(503, "NotificationDB no disponible"); }
}).RequireAuthorization();

app.MapPatch("/api/notifications/{id}/read", async (ClaimsPrincipal user, NotificationDatabase db, string id, CancellationToken ct) =>
{
    var subject = user.FindFirstValue("sub");
    if (string.IsNullOrWhiteSpace(subject)) return Error(401, "No autenticado");
    if (!Guid.TryParse(id, out var uuid)) return Error(404, "Notificación no encontrada");
    try
    {
        var result = await db.MarkReadAsync(subject, uuid, ct);
        return result is null ? Error(404, "Notificación no encontrada") : Results.Ok(result);
    }
    catch { return Error(503, "NotificationDB no disponible"); }
}).RequireAuthorization();

app.Run();

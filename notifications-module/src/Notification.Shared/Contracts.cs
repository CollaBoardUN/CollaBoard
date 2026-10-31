using System.Text.Json;
using System.Text.Json.Serialization;

namespace CollaBoard.Notifications;

public sealed record NotificationEvent(
    [property: JsonPropertyName("event_id")] string EventId,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("occurred_at")] DateTimeOffset OccurredAt,
    [property: JsonPropertyName("actor_id")] string ActorId,
    [property: JsonPropertyName("board_id")] string BoardId,
    [property: JsonPropertyName("recipient_ids")] List<string> RecipientIds,
    [property: JsonPropertyName("payload")] JsonElement Payload);

public sealed record NotificationItem(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("board_id")] string? BoardId,
    [property: JsonPropertyName("actor_id")] string? ActorId,
    [property: JsonPropertyName("payload")] JsonElement Payload,
    [property: JsonPropertyName("created_at")] DateTimeOffset CreatedAt,
    [property: JsonPropertyName("read_at")] DateTimeOffset? ReadAt);

public sealed record InboxResponse(
    [property: JsonPropertyName("items")] List<NotificationItem> Items,
    [property: JsonPropertyName("unread_count")] int UnreadCount);

public static class EventValidation
{
    public static string? Error(NotificationEvent? e)
    {
        if (e == null) return "Evento inválido";
        if (string.IsNullOrWhiteSpace(e.EventId) || e.EventId.Length > 128) return "event_id inválido";
        if (e.Type is not ("invite.accepted" or "chat.message.created")) return "Tipo de evento inválido";
        if (e.OccurredAt == default) return "occurred_at requerido";
        if (string.IsNullOrWhiteSpace(e.ActorId) || e.ActorId.Length > 128) return "actor_id inválido";
        if (string.IsNullOrWhiteSpace(e.BoardId) || e.BoardId.Length > 128) return "board_id inválido";
        if (e.RecipientIds == null || e.RecipientIds.Count > 200 || e.RecipientIds.Any(id => string.IsNullOrWhiteSpace(id) || id.Length > 128))
            return "recipient_ids inválidos";
        if (e.Payload.ValueKind != JsonValueKind.Object || e.Payload.GetRawText().Length > 4096)
            return "payload inválido";
        return null;
    }
}

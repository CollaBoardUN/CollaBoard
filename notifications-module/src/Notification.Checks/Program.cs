using System.Text.Json;
using CollaBoard.Notifications;

var valid = new NotificationEvent(
    "evt-abc", "chat.message.created", DateTimeOffset.UtcNow,
    "author", "board-123", ["author", "recipient"],
    JsonSerializer.SerializeToElement(new { board_name = "Tablero", preview = "Hola" }));

void Check(bool success, string name)
{
    if (!success) throw new Exception($"FALLÓ: {name}");
    Console.WriteLine($"OK: {name}");
}

Check(EventValidation.Error(valid) is null, "Evento de Chat válido");
Check(EventValidation.Error(valid with { Type = "otro" }) is not null, "Tipo desconocido rechazado");
Check(EventValidation.Error(valid with { RecipientIds = [""] }) is not null, "Destinatario inválido rechazado");
Check(EventValidation.Error(valid with { BoardId = "" }) is not null, "Tablero vacío rechazado");
Check(EventValidation.Error(valid with { Payload = JsonSerializer.SerializeToElement("texto") }) is not null,
    "Payload no objeto rechazado");
Console.WriteLine("Comprobaciones de contrato completadas");

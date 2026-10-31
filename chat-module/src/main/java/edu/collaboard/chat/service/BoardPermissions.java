package edu.collaboard.chat.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** Puerto de permisos: no acopla Chat al futuro contrato interno de Colaboración. */
public interface BoardPermissions {
    JsonNode requireBoard(String token, String boardId);
    List<String> memberIds(String token, String boardId);
}

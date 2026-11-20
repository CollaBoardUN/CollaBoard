package edu.collaboard.chat.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** Puerto del Policy Enforcement Point (PEP) de Chat hacia el PDP de Colaboración. */
public interface BoardPermissions {
    JsonNode requireBoard(String token, String boardId);

    default JsonNode requireAction(String token, String boardId, String action) {
        return requireBoard(token, boardId);
    }

    List<String> memberIds(String token, String boardId);

    default void invalidateBoard(String boardId) {}
}

package edu.collaboard.chat.security;

public record ChatPrincipal(String id, String name, String token) {
    @Override public String toString() { return "ChatPrincipal[id=" + id + "]"; }
}

"use client";

import { useEffect, useState } from "react";

import { copyText } from "@/core/lib/clipboard";
import { ROLE_HINT, ROLE_LABEL, relativeTime } from "@/core/lib/format";
import type { Board, Invite, Member, ShareableRole } from "@/core/domain/types";
import { toast } from "@/core/stores/toastStore";
import { useApis, useSessionUser } from "../AppContext";
import { Avatar } from "../common/Avatar";
import { Modal } from "../common/Modal";
import { RoleBadge } from "../common/RoleBadge";

const EXPIRY_OPTIONS: { label: string; hours: number | null }[] = [
  { label: "1 día", hours: 24 },
  { label: "7 días", hours: 168 },
  { label: "30 días", hours: 720 },
  { label: "Sin vencimiento", hours: null },
];

interface Props {
  board: Board;
  onClose: () => void;
  onMembersChange?: (count: number) => void;
}

export function ShareDialog({ board, onClose, onMembersChange }: Props) {
  const me = useSessionUser();
  const { boards: boardsApi } = useApis();
  const isOwner = board.my_role === "owner";

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [role, setRole] = useState<ShareableRole>("editor");
  const [expiry, setExpiry] = useState<number | null>(168);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<Invite | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      boardsApi.members(board.id),
      isOwner ? boardsApi.invites(board.id) : Promise.resolve([] as Invite[]),
    ])
      .then(([m, i]) => {
        if (!alive) return;
        setMembers(m);
        setInvites(i);
      })
      .catch((e: Error) => alive && setLoadError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [board.id, isOwner, boardsApi]);

  async function createLink() {
    setCreating(true);
    try {
      const invite = await boardsApi.createInvite(board.id, role, expiry);
      setFresh(invite);
      setInvites((list) => [invite, ...list]);
      if (await copyText(invite.url)) toast.ok("Link copiado");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function copy(url: string) {
    if (await copyText(url)) toast.ok("Link copiado");
    else toast.error("No se pudo copiar. Selecciona el link y cópialo a mano.");
  }

  async function revoke(invite: Invite) {
    try {
      await boardsApi.revokeInvite(board.id, invite.id);
      setInvites((list) => list.filter((i) => i.id !== invite.id));
      if (fresh?.id === invite.id) setFresh(null);
      toast.ok("Link desactivado");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function changeRole(member: Member, next: ShareableRole) {
    try {
      const updated = await boardsApi.changeRole(board.id, member.user_id, next);
      setMembers((list) => list.map((m) => (m.user_id === member.user_id ? updated : m)));
      toast.ok(`${member.display_name ?? member.user_id} ahora: ${ROLE_LABEL[next].toLowerCase()}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function removeMember(member: Member) {
    try {
      await boardsApi.removeMember(board.id, member.user_id);
      const next = members.filter((m) => m.user_id !== member.user_id);
      setMembers(next);
      onMembersChange?.(next.length);
      toast.ok(`${member.display_name ?? member.user_id} ya no tiene acceso`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Modal title={`Compartir “${board.name}”`} onClose={onClose} wide>
      {isOwner ? (
        <section className="share-create" aria-label="Invitar con un link">
          <fieldset className="segmented">
            <legend>Quien abra el link podrá</legend>
            {(["editor", "viewer"] as const).map((r) => (
              <label key={r} className={role === r ? "seg seg-on" : "seg"}>
                <input
                  type="radio"
                  name="invite-role"
                  value={r}
                  checked={role === r}
                  onChange={() => setRole(r)}
                />
                <strong>{ROLE_LABEL[r]}</strong>
                <small>{ROLE_HINT[r]}</small>
              </label>
            ))}
          </fieldset>
          <div className="share-row">
            <label className="field field-inline">
              <span>El link vence en</span>
              <select
                value={expiry ?? "never"}
                onChange={(e) => setExpiry(e.target.value === "never" ? null : Number(e.target.value))}
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.label} value={o.hours ?? "never"}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-primary" onClick={createLink} disabled={creating}>
              {creating ? "Creando…" : "Crear y copiar link"}
            </button>
          </div>
          {fresh && (
            <div className="link-box">
              <input readOnly value={fresh.url} aria-label="Link de invitación" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn btn-quiet" onClick={() => copy(fresh.url)}>
                Copiar
              </button>
            </div>
          )}
        </section>
      ) : (
        <p className="note">Solo el dueño del tablero puede invitar personas y cambiar permisos.</p>
      )}

      {loading ? (
        <p className="muted">Cargando…</p>
      ) : loadError ? (
        <p className="form-error">{loadError}</p>
      ) : (
        <>
          {isOwner && invites.length > 0 && (
            <section className="share-section">
              <h3>Links activos</h3>
              <ul className="rows">
                {invites.map((inv) => (
                  <li key={inv.id} className="row">
                    <div className="row-main">
                      <RoleBadge role={inv.role} />
                      <span className="muted">
                        {inv.uses === 1 ? "1 persona se unió" : `${inv.uses} personas se unieron`}
                        {inv.expires_at ? `, vence ${relativeTime(inv.expires_at)}` : ", sin vencimiento"}
                      </span>
                    </div>
                    <div className="row-actions">
                      <button type="button" className="btn btn-small btn-quiet" onClick={() => copy(inv.url)}>
                        Copiar
                      </button>
                      <button type="button" className="btn btn-small btn-quiet-danger" onClick={() => revoke(inv)}>
                        Desactivar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="share-section">
            <h3>Personas con acceso ({members.length})</h3>
            <ul className="rows">
              {members.map((m) => {
                const name = m.display_name ?? m.user_id;
                const isMe = m.user_id === me.id;
                return (
                  <li key={m.user_id} className="row">
                    <div className="row-main">
                      <Avatar id={m.user_id} name={name} />
                      <span className="member-name">
                        {name}
                        {isMe && <span className="muted"> (tú)</span>}
                      </span>
                    </div>
                    <div className="row-actions">
                      {isOwner && m.role !== "owner" ? (
                        <>
                          <select
                            aria-label={`Permiso de ${name}`}
                            value={m.role}
                            onChange={(e) => changeRole(m, e.target.value as ShareableRole)}
                          >
                            <option value="editor">{ROLE_LABEL.editor}</option>
                            <option value="viewer">{ROLE_LABEL.viewer}</option>
                          </select>
                          <button
                            type="button"
                            className="btn btn-small btn-quiet-danger"
                            onClick={() => removeMember(m)}
                            aria-label={`Quitar a ${name}`}
                          >
                            Quitar
                          </button>
                        </>
                      ) : (
                        <RoleBadge role={m.role} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </Modal>
  );
}

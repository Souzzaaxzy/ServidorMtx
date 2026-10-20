// ──────────────────────────────────────────────────────────────
// Presença — quem está ONLINE agora.
//
// O QUE CONTA COMO ONLINE: o usuário ter uma conexão WebSocket viva E o app
// estar em PRIMEIRO PLANO. As duas condições vêm do cliente real, não de um
// palpite: o socket é aberto quando o app sobe e o APK manda um frame
// `away`/`active` no ciclo de vida. Assim "usuário fora do aplicativo =
// offline" e "usuário dentro do aplicativo = online" saem direto do estado
// real — nunca de um heartbeat otimista nem de uma data de "visto por
// último" (que diria "online" para quem fechou o app há horas).
//
// POR QUE O SERVIDOR MANDA O ESTADO: o app só conhece os sockets que ELE
// abriu. Para ver a bolinha de OUTRA pessoa é o servidor que precisa dizer
// quem está online — por isso ele é a autoridade e faz o fan-out das
// transições.
//
// CUSTO: o registro vive em memória, então consultar a presença de uma lista
// de conversas é O(1) por usuário — nenhuma query, nenhuma tabela nova. Um
// restart apenas zera a presença; o próximo socket a reconstrói.
// ──────────────────────────────────────────────────────────────

import { logger } from '../../config/logger.js';
import { prisma } from '../../config/prisma.js';

// ── Registro em memória ──────────────────────────────────────
// Contagem de conexões por usuário (um usuário pode ter mais de um socket:
// reconexão, dois aparelhos) + visibilidade explícita do app.
const connections = new Map<string, number>();
const hidden = new Set<string>();

/**
 * Online = tem socket vivo E o app está visível. O padrão é VISÍVEL: um
 * cliente que ainda não sabe mandar `away` (build antigo) continua contando
 * como online enquanto tiver socket — nunca "desaparece" por falta do frame.
 */
export function isUserOnline(userId: string): boolean {
  if (userId === '') return false;
  return (connections.get(userId) ?? 0) > 0 && !hidden.has(userId);
}

/** Quantos dos ids estão online (cabeçalho do grupo). */
export function onlineCount(userIds: string[]): number {
  let count = 0;
  for (const id of userIds) {
    if (isUserOnline(id)) count += 1;
  }
  return count;
}

/** Presença de vários usuários de uma vez (lista de conversas). */
export function presenceMap(userIds: string[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const id of userIds) map[id] = isUserOnline(id);
  return map;
}

/**
 * Uma conexão do usuário foi aberta. Idempotente por contagem: o estado só
 * muda quando a PRIMEIRA conexão aparece (ou a última some).
 */
export function registerConnection(userId: string): void {
  if (userId === '') return;
  connections.set(userId, (connections.get(userId) ?? 0) + 1);
  if (connections.get(userId) === 1) scheduleAnnounce(userId);
}

/** Uma conexão do usuário foi fechada (última → offline). */
export function unregisterConnection(userId: string): void {
  if (userId === '') return;
  const current = connections.get(userId) ?? 0;
  if (current <= 1) {
    connections.delete(userId);
    // Sem socket não há "visível" pendente: limpa para não vazar estado.
    hidden.delete(userId);
    scheduleAnnounce(userId);
    return;
  }
  connections.set(userId, current - 1);
}

/**
 * O app entrou/saiu de primeiro plano (frame `active`/`away`). É isto que
 * implementa literalmente "usuário fora do aplicativo = offline".
 */
export function setUserVisible(userId: string, visible: boolean): void {
  if (userId === '') return;
  if (visible) {
    if (!hidden.delete(userId)) return; // já estava visível: nada a anunciar
  } else {
    if (hidden.has(userId)) return;
    hidden.add(userId);
  }
  scheduleAnnounce(userId);
}

// ── Fan-out das transições ───────────────────────────────────
// Quando A fica online/offline, quem precisa saber é quem conversa com A
// (peers de DM + colegas de grupo). Mandar para todos seria ruído, então o
// alvo é derivado do banco UMA vez por transição — nunca por leitura de lista.

type PresenceFrame = {
  userId: string;
  online: boolean;
  /** Grupos compartilhados com o usuário que mudou, já com a nova contagem. */
  groups: { groupId: string; onlineCount: number }[];
};

/**
 * O transporte real é injetado pelo módulo de push (que é quem tem o hub de
 * sockets). A injeção evita import circular: presence não conhece push.
 */
type PresenceDispatcher = (userIds: string[], frame: PresenceFrame) => void;

let dispatcher: PresenceDispatcher | null = null;

/** O push.service chama isto UMA vez, no boot, para ligar o transporte. */
export function setPresenceDispatcher(fn: PresenceDispatcher): void {
  dispatcher = fn;
}

// Coalescência: abrir/fechar o app gera um par away→active em poucos
// milissegundos (tela apagando, teclado, uma chamada recebida). Sem isso cada
// oscilação viraria uma rajada de frames para todos os contatos.
const ANNOUNCE_DEBOUNCE_MS = 150;
const announceTimers = new Map<string, NodeJS.Timeout>();
const lastAnnounced = new Map<string, boolean>();

/**
 * Agenda o anúncio da presença ATUAL de [userId]. Coalescido e idempotente:
 * chamadas repetidas com o mesmo estado não geram frames repetidos, e o
 * estado é reavaliado no disparo (pode ter voltado ao anterior).
 */
function scheduleAnnounce(userId: string): void {
  const pending = announceTimers.get(userId);
  if (pending) clearTimeout(pending);
  announceTimers.set(
    userId,
    setTimeout(() => {
      announceTimers.delete(userId);
      const online = isUserOnline(userId);
      if (lastAnnounced.get(userId) === online) return;
      lastAnnounced.set(userId, online);
      void fanOut(userId, online);
    }, ANNOUNCE_DEBOUNCE_MS),
  );
}

async function fanOut(userId: string, online: boolean): Promise<void> {
  if (dispatcher === null) return;
  try {
    const { audience, groups } = await presenceAudience(userId);
    if (audience.length === 0) return;
    dispatcher(audience, { userId, online, groups });
  } catch (err) {
    // Best-effort: a presença é enfeite de UI; nunca derruba um request.
    logger.warn({ err }, 'presence fan-out failed');
  }
}

/**
 * Quem deve receber a transição de [userId] e, para os grupos em comum, a
 * NOVA contagem de online. A contagem é calculada aqui (o servidor é quem
 * conhece a lista de membros) para o app não precisar dela.
 */
async function presenceAudience(userId: string): Promise<{
  audience: string[];
  groups: { groupId: string; onlineCount: number }[];
}> {
  const [conversations, memberships] = await Promise.all([
    prisma.conversation.findMany({
      where: { OR: [{ userOneId: userId }, { userTwoId: userId }] },
      select: { userOneId: true, userTwoId: true },
    }),
    prisma.groupMember.findMany({
      where: { userId, bannedAt: null },
      select: { groupId: true },
    }),
  ]);

  const audience = new Set<string>();
  for (const c of conversations) {
    audience.add(c.userOneId === userId ? c.userTwoId : c.userOneId);
  }

  const groups: { groupId: string; onlineCount: number }[] = [];
  const groupIds = memberships.map((m) => m.groupId);
  if (groupIds.length > 0) {
    const memberRows = await prisma.groupMember.findMany({
      where: { groupId: { in: groupIds }, bannedAt: null },
      select: { groupId: true, userId: true },
    });
    const byGroup = new Map<string, string[]>();
    for (const row of memberRows) {
      const list = byGroup.get(row.groupId);
      if (list) list.push(row.userId);
      else byGroup.set(row.groupId, [row.userId]);
      if (row.userId !== userId) audience.add(row.userId);
    }
    for (const [groupId, memberIds] of byGroup) {
      groups.push({ groupId, onlineCount: onlineCount(memberIds) });
    }
  }

  audience.delete(userId); // ninguém precisa saber da própria presença
  return { audience: [...audience], groups };
}

/** Limpa timers/estado de anúncio e o registro (usado por testes). */
export function resetPresence(): void {
  for (const timer of announceTimers.values()) clearTimeout(timer);
  announceTimers.clear();
  lastAnnounced.clear();
  connections.clear();
  hidden.clear();
}

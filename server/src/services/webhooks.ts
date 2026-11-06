import { randomBytes } from "node:crypto";
import { env } from "../config/env.ts";
import { DecryptError, decrypt, encrypt } from "../lib/crypto.ts";
import { prisma } from "../lib/prisma.ts";
import type { ForgeConnection, Repository } from "../generated/prisma/client.ts";
import { forgeName } from "../review/forge/providers.ts";
import { adapterForConnection } from "./forge.ts";
import { providerFor, type WebhookState } from "./providers/index.ts";

export type { WebhookState } from "./providers/index.ts";

export function webhookUrl(provider: string, repositoryId: string): string {
  return `${env.API_PUBLIC_URL.replace(/\/+$/, "")}/api/webhooks/${provider}/${repositoryId}`;
}

const REGISTRATION_TIMEOUT_MS = 65_000;

function unavailable(repo: Repository, err: unknown): WebhookState {
  const reason = err instanceof Error ? err.message : String(err);
  return {
    active: false,
    error: `Automatic reviews are off: ${forgeName(repo.provider)} refused the webhook (${reason})`,
  };
}

export async function ensureWebhook(repo: Repository, connection: ForgeConnection): Promise<WebhookState> {
  const appState = providerFor(connection.provider).appWebhook?.(connection);
  if (appState) return appState;
  if (repo.webhookId) return { active: true };

  const adapter = adapterForConnection(connection);
  const url = webhookUrl(repo.provider, repo.id);
  return prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(
        hashtext(${"webhook-registration"}::text),
        hashtext(${repo.id}::text)
      ) AS acquired`;
    if (!lock?.acquired) {
      return {
        active: false,
        error: "Webhook registration is already in progress; try again shortly.",
      };
    }

    const current = await tx.repository.findUniqueOrThrow({ where: { id: repo.id } });
    if (current.webhookId) return { active: true };

    const recovering = current.encryptedWebhookSecret !== null;
    const secret = recovering ? decrypt(current.encryptedWebhookSecret!) : randomBytes(32).toString("hex");
    const encryptedWebhookSecret = current.encryptedWebhookSecret ?? encrypt(secret);
    if (!recovering) {
      // Commit the claim outside this lock-owning transaction. If the process
      // dies after the forge creates the hook, the secret survives the
      // transaction rollback and a later request can identify the hook.
      const { count } = await prisma.repository.updateMany({
        where: { id: repo.id, webhookId: null, encryptedWebhookSecret: null },
        data: { encryptedWebhookSecret },
      });
      if (count === 0) {
        const latest = await tx.repository.findUniqueOrThrow({ where: { id: repo.id } });
        return latest.webhookId ? { active: true } : {
          active: false,
          error: "Webhook registration state changed; try again shortly.",
        };
      }
    }

    let webhookId: string;
    try {
      const existing = recovering ? await adapter.findHook(repo, url) : null;
      webhookId = existing ?? await adapter.createHook(repo, url, secret);
    } catch (err) {
      // Keep the secret because a timeout may mean the forge created the hook
      // but its response never reached us. The next request reconciles by URL.
      return unavailable(repo, err);
    }

    const saved = await prisma.repository.updateMany({
      where: { id: repo.id, webhookId: null, encryptedWebhookSecret },
      data: { webhookId },
    });
    if (saved.count === 1) return { active: true };

    // The repository was removed or its registration was replaced while the
    // forge call was in flight. Do not leave the hook this attempt obtained.
    await adapter.deleteHook(repo, webhookId).catch((err: unknown) => {
      console.warn(`Could not remove unclaimed ${repo.provider} hook ${webhookId} from ${repo.fullPath}`, err);
    });
    const latest = await tx.repository.findUnique({ where: { id: repo.id } });
    return latest?.webhookId ? { active: true } : {
      active: false,
      error: "Webhook registration state changed; try again shortly.",
    };
  }, { timeout: REGISTRATION_TIMEOUT_MS });
}

// Best effort: a hook left behind only delivers events Sentryward then ignores.
export async function removeWebhook(repo: Repository, connection: ForgeConnection): Promise<void> {
  if (providerFor(connection.provider).appWebhook?.(connection) || !repo.webhookId) return;
  const hookId = repo.webhookId;
  await adapterForConnection(connection)
    .deleteHook(repo, hookId)
    .catch((err: unknown) => {
      console.warn(`Could not remove ${repo.provider} hook ${hookId} from ${repo.fullPath}`, err);
    });
  await prisma.repository.update({
    where: { id: repo.id },
    data: { webhookId: null, encryptedWebhookSecret: null },
  });
}

// A secret saved under another ENCRYPTION_KEY verifies nothing, so the hook
// gets the usual 401; re-enabling the repository registers a fresh one.
export function webhookSecret(repo: Repository): string | null {
  if (!repo.encryptedWebhookSecret) return null;
  try {
    return decrypt(repo.encryptedWebhookSecret);
  } catch (error) {
    if (!(error instanceof DecryptError)) throw error;
    console.warn(`Webhook secret for ${repo.fullPath} cannot be decrypted; re-enable the repository to replace it`);
    return null;
  }
}

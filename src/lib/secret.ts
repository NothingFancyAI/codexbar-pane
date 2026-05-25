// Keyring access for API-provider tokens (e.g. Codex session cookies).
// Ported verbatim from the reference secret.js, typed.

import Secret from 'gi://Secret';

const SECRET_SCHEMA_NAME = 'org.gnome.shell.extensions.codexbar-pane.token';

const TOKEN_SCHEMA = Secret.Schema.new(
    SECRET_SCHEMA_NAME,
    Secret.SchemaFlags.NONE,
    {provider_id: Secret.SchemaAttributeType.STRING},
);

export function storeToken(providerId: string, token: string): boolean {
    return Secret.password_store_sync(
        TOKEN_SCHEMA,
        {provider_id: providerId},
        Secret.COLLECTION_DEFAULT,
        `CodexBar Pane token for ${providerId}`,
        token,
        null,
    );
}

export function loadToken(providerId: string): string | null {
    return Secret.password_lookup_sync(TOKEN_SCHEMA, {provider_id: providerId}, null);
}

export function clearToken(providerId: string): boolean {
    return Secret.password_clear_sync(TOKEN_SCHEMA, {provider_id: providerId}, null);
}

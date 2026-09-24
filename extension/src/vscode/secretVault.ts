import * as vscode from 'vscode';
import { KeyVault } from '../session/sessionStore';

/**
 * Custodia de la clave Ed25519 de sesión en ExtensionContext.secrets
 * (Sección 5.2): almacenamiento cifrado por el llavero del sistema.
 */
export class SecretKeyVault implements KeyVault {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(sessionUuid: string): string {
    return `uatu.session.${sessionUuid}.ed25519`;
  }

  async get(sessionUuid: string): Promise<Buffer | undefined> {
    const value = await this.secrets.get(this.key(sessionUuid));
    return value ? Buffer.from(value, 'base64') : undefined;
  }

  async store(sessionUuid: string, privateKeyDer: Buffer): Promise<void> {
    await this.secrets.store(this.key(sessionUuid), privateKeyDer.toString('base64'));
  }

  async delete(sessionUuid: string): Promise<void> {
    await this.secrets.delete(this.key(sessionUuid));
  }
}

import { Plugin, PluginSettingTab, App, Setting, Notice, Editor, MarkdownView, Modal } from 'obsidian';
import * as openpgp from 'openpgp';

interface PluginData {
  privateKey: string;
  publicKey: string;
  name: string;
  email: string;
}

const DEFAULT_DATA: PluginData = {
  privateKey: '',
  publicKey: '',
  name: 'Obsidian User',
  email: 'user@obsidian.local',
};

const SIGNATURE_DELIMITER = '\n\n---\n<!-- obs-pgp-signature -->\n';

export default class ObsPgpPlugin extends Plugin {
  data: PluginData;

  async onload() {
    const saved = await this.loadData();
    this.data = Object.assign({}, DEFAULT_DATA, saved);

    if (!this.data.privateKey || !this.data.publicKey) {
      await this.generateKeypair();
      new BackupKeyModal(this.app, this.data.privateKey, this.data.publicKey).open();
    }

    this.addRibbonIcon('pencil', 'Sign this note', () => {
      this.signNote();
    });

    this.addCommand({
      id: 'sign-note',
      name: 'Sign this note',
      callback: () => this.signNote(),
    });

    this.addCommand({
      id: 'verify-signature',
      name: 'Verify signature',
      callback: () => this.verifyNote(),
    });

    this.addSettingTab(new ObsPgpSettingTab(this.app, this));
  }

  async savePluginData() {
    await this.saveData(this.data);
  }

  async generateKeypair() {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: 'rsa',
      rsaBits: 2048,
      userIDs: [{ name: this.data.name, email: this.data.email }],
      format: 'armored',
    });
    this.data.privateKey = privateKey;
    this.data.publicKey = publicKey;
    await this.savePluginData();
    new Notice('PGP keypair generated.');
  }

  async signNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice('No active note.');
      return;
    }
    const editor: Editor = view.editor;
    let fullContent = editor.getValue();

    const delimIdx = fullContent.indexOf('\n\n---\n<!-- obs-pgp-signature -->');
    if (delimIdx !== -1) {
      fullContent = fullContent.substring(0, delimIdx);
    }

    try {
      const privateKeyObj = await openpgp.readPrivateKey({ armoredKey: this.data.privateKey });
      const message = await openpgp.createCleartextMessage({ text: fullContent });
      const signed = await openpgp.sign({
        message,
        signingKeys: privateKeyObj,
      });

      editor.setValue(fullContent + SIGNATURE_DELIMITER + signed);
      new Notice('Note signed.');
    } catch (e) {
      new Notice('Error signing note: ' + (e as Error).message);
    }
  }

  async verifyNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice('No active note.');
      return;
    }
    const editor: Editor = view.editor;
    const fullContent = editor.getValue();

    const startMarker = '-----BEGIN PGP SIGNED MESSAGE-----';
    const endMarker = '-----END PGP SIGNATURE-----';

    const startIdx = fullContent.indexOf(startMarker);
    if (startIdx === -1) {
      new Notice('No signature block found.');
      return;
    }

    const endIdx = fullContent.indexOf(endMarker, startIdx);
    if (endIdx === -1) {
      new Notice('Malformed signature block.');
      return;
    }

    const armoredBlock = fullContent.substring(startIdx, endIdx + endMarker.length);

    try {
      const publicKeyObj = await openpgp.readKey({ armoredKey: this.data.publicKey });
      const message = await openpgp.readCleartextMessage({ cleartextMessage: armoredBlock });
      const result = await openpgp.verify({
        message,
        verificationKeys: publicKeyObj,
      });

      const sig = result.signatures[0];
      try {
        await sig.verified;
        new Notice('Signature valid ✓');
      } catch {
        new Notice('Signature INVALID ✗');
      }
    } catch (e) {
      new Notice('Error verifying signature: ' + (e as Error).message);
    }
  }
}

// --- Modals ---

class BackupKeyModal extends Modal {
  private privateKey: string;
  private publicKey: string;

  constructor(app: App, privateKey: string, publicKey: string) {
    super(app);
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Back up your signing key' });
    contentEl.createEl('p', {
      text: 'A new PGP signing key was created for you. Save it to a USB drive and keep it somewhere safe — if you lose it, you cannot sign from a new device or recover your identity.',
    });
    contentEl.createEl('p', {
      text: 'You can also import this key on any other Obsidian device to sign with the same identity.',
      attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
    });

    const btnDiv = contentEl.createDiv({ cls: 'modal-button-container', attr: { style: 'margin-top: 1em;' } });

    const savePrivBtn = btnDiv.createEl('button', { text: 'Save Private Key (.asc)', cls: 'mod-cta' });
    savePrivBtn.addEventListener('click', () => {
      downloadTextFile('obs-pgp-private.asc', this.privateKey);
      new Notice('Private key saved — store it securely.');
    });

    const savePubBtn = btnDiv.createEl('button', { text: 'Save Public Key (.asc)', attr: { style: 'margin-left: 8px;' } });
    savePubBtn.addEventListener('click', () => {
      downloadTextFile('obs-pgp-public.asc', this.publicKey);
      new Notice('Public key saved.');
    });

    const dismissBtn = btnDiv.createEl('button', { text: 'I\'ll do this later', attr: { style: 'margin-left: 8px;' } });
    dismissBtn.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ImportKeyModal extends Modal {
  private onImport: (privateKey: string, publicKey: string) => void;

  constructor(app: App, onImport: (privateKey: string, publicKey: string) => void) {
    super(app);
    this.onImport = onImport;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Import existing key' });
    contentEl.createEl('p', {
      text: 'Paste your private key below (the .asc file you saved during setup). The public key will be derived from it automatically.',
    });

    const textarea = contentEl.createEl('textarea', {
      attr: {
        rows: '14',
        placeholder: '-----BEGIN PGP PRIVATE KEY BLOCK-----\n...',
        style: 'width:100%;font-family:monospace;font-size:11px;resize:vertical;margin-top:8px;',
      },
    });

    const errorEl = contentEl.createEl('p', {
      attr: { style: 'color: var(--text-error); font-size: 0.85em; min-height: 1.2em;' },
    });

    const btnDiv = contentEl.createDiv({ cls: 'modal-button-container', attr: { style: 'margin-top: 0.5em;' } });

    const importBtn = btnDiv.createEl('button', { text: 'Import Key', cls: 'mod-cta' });
    importBtn.addEventListener('click', async () => {
      errorEl.textContent = '';
      const armoredKey = textarea.value.trim();
      if (!armoredKey) {
        errorEl.textContent = 'Please paste your private key.';
        return;
      }
      try {
        const privateKeyObj = await openpgp.readPrivateKey({ armoredKey });
        const publicKey = privateKeyObj.toPublic().armor();
        this.close();
        this.onImport(armoredKey, publicKey);
      } catch (e) {
        errorEl.textContent = 'Could not read the key: ' + (e as Error).message;
      }
    });

    const cancelBtn = btnDiv.createEl('button', { text: 'Cancel', attr: { style: 'margin-left: 8px;' } });
    cancelBtn.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  private title: string;
  private body: string;
  private confirmLabel: string;
  private onConfirm: () => void;

  constructor(app: App, title: string, body: string, confirmLabel: string, onConfirm: () => void) {
    super(app);
    this.title = title;
    this.body = body;
    this.confirmLabel = confirmLabel;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.title });
    contentEl.createEl('p', { text: this.body });
    const btnDiv = contentEl.createDiv({ cls: 'modal-button-container' });
    const confirmBtn = btnDiv.createEl('button', { text: this.confirmLabel, cls: 'mod-warning' });
    confirmBtn.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
    const cancelBtn = btnDiv.createEl('button', { text: 'Cancel', attr: { style: 'margin-left: 8px;' } });
    cancelBtn.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- Settings ---

class ObsPgpSettingTab extends PluginSettingTab {
  plugin: ObsPgpPlugin;

  constructor(app: App, plugin: ObsPgpPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'OBS PGP Signer' });

    new Setting(containerEl)
      .setName('Name')
      .setDesc('Your name for the PGP key identity.')
      .addText((text) =>
        text
          .setValue(this.plugin.data.name)
          .onChange((value) => {
            this.plugin.data.name = value;
          })
      );

    new Setting(containerEl)
      .setName('Email')
      .setDesc('Your email for the PGP key identity.')
      .addText((text) =>
        text
          .setValue(this.plugin.data.email)
          .onChange((value) => {
            this.plugin.data.email = value;
          })
      );

    new Setting(containerEl)
      .setName('Regenerate keypair')
      .setDesc('Create a new PGP keypair using the name and email above. Old signatures will no longer verify.')
      .addButton((btn) =>
        btn
          .setButtonText('Save & Regenerate')
          .setWarning()
          .onClick(() => {
            new ConfirmModal(
              this.app,
              'Regenerate keypair?',
              'This will create a new PGP keypair. Old signatures cannot be verified with the new key. Continue?',
              'Regenerate',
              async () => {
                await this.plugin.savePluginData();
                await this.plugin.generateKeypair();
                new BackupKeyModal(this.app, this.plugin.data.privateKey, this.plugin.data.publicKey).open();
                this.display();
              }
            ).open();
          })
      );

    new Setting(containerEl)
      .setName('Import existing key')
      .setDesc('Already have a key from another device? Import it here to sign with the same identity.')
      .addButton((btn) =>
        btn.setButtonText('Import key…').onClick(() => {
          new ImportKeyModal(this.app, async (privateKey, publicKey) => {
            this.plugin.data.privateKey = privateKey;
            this.plugin.data.publicKey = publicKey;
            await this.plugin.savePluginData();
            new Notice('Key imported successfully.');
            this.display();
          }).open();
        })
      );

    containerEl.createEl('h3', { text: 'Your public key', attr: { style: 'margin-top: 2em;' } });
    containerEl.createEl('p', {
      text: 'Share this with readers so they can verify your signatures.',
      attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
    });

    new Setting(containerEl)
      .addButton((btn) =>
        btn.setButtonText('Copy public key').onClick(() => {
          navigator.clipboard.writeText(this.plugin.data.publicKey).then(() => {
            new Notice('Public key copied to clipboard.');
          });
        })
      )
      .addButton((btn) =>
        btn.setButtonText('Save public key (.asc)').onClick(() => {
          downloadTextFile('obs-pgp-public.asc', this.plugin.data.publicKey);
        })
      );

    const pubKeyArea = containerEl.createEl('textarea', {
      attr: {
        readonly: 'true',
        rows: '12',
        style: 'width:100%;font-family:monospace;font-size:11px;resize:vertical;margin-top:8px;',
      },
    });
    pubKeyArea.value = this.plugin.data.publicKey;

    containerEl.createEl('h3', { text: 'Back up your private key', attr: { style: 'margin-top: 2em;' } });
    containerEl.createEl('p', {
      text: 'Save your private key to a USB drive. You need it to sign from a new device.',
      attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
    });

    new Setting(containerEl)
      .addButton((btn) =>
        btn.setButtonText('Save private key (.asc)').setCta().onClick(() => {
          downloadTextFile('obs-pgp-private.asc', this.plugin.data.privateKey);
          new Notice('Private key saved — keep it safe!');
        })
      );
  }
}

// --- Helpers ---

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

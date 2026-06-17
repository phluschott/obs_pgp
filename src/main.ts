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

    // Strip existing signature block if present
    const delimIdx = fullContent.indexOf('\n\n---\n<!-- obs-pgp-signature -->');
    if (delimIdx !== -1) {
      fullContent = fullContent.substring(0, delimIdx);
    }

    const content = fullContent;

    try {
      const privateKeyObj = await openpgp.readPrivateKey({ armoredKey: this.data.privateKey });
      const message = await openpgp.createCleartextMessage({ text: content });
      const signed = await openpgp.sign({
        message,
        signingKeys: privateKeyObj,
      });

      const newContent = content + SIGNATURE_DELIMITER + signed;
      editor.setValue(newContent);
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
      .setName('Regenerate Keypair')
      .setDesc('Save name/email and generate a new PGP keypair. Old signatures will no longer verify.')
      .addButton((btn) =>
        btn
          .setButtonText('Save & Regenerate Keypair')
          .setWarning()
          .onClick(() => {
            new ConfirmModal(this.app, async () => {
              await this.plugin.savePluginData();
              await this.plugin.generateKeypair();
              this.display();
            }).open();
          })
      );

    new Setting(containerEl)
      .setName('Public Key')
      .setDesc('Your PGP public key. Share this so others can verify your signatures.')
      .addButton((btn) =>
        btn.setButtonText('Copy Public Key').onClick(() => {
          navigator.clipboard.writeText(this.plugin.data.publicKey).then(() => {
            new Notice('Public key copied to clipboard.');
          });
        })
      );

    const pubKeyArea = containerEl.createEl('textarea', {
      attr: {
        readonly: 'true',
        rows: '12',
        style: 'width:100%;font-family:monospace;font-size:11px;resize:vertical;',
      },
    });
    pubKeyArea.value = this.plugin.data.publicKey;
  }
}

class ConfirmModal extends Modal {
  private onConfirm: () => void;

  constructor(app: App, onConfirm: () => void) {
    super(app);
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Regenerate keypair?' });
    contentEl.createEl('p', {
      text: 'This will create a new PGP keypair. Old signatures cannot be verified with the new key. Continue?',
    });
    const btnDiv = contentEl.createDiv({ cls: 'modal-button-container' });
    const confirmBtn = btnDiv.createEl('button', { text: 'Regenerate', cls: 'mod-warning' });
    confirmBtn.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
    const cancelBtn = btnDiv.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

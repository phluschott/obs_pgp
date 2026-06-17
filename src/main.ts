import { Plugin, PluginSettingTab, App, Setting, Notice, Editor, MarkdownView, Modal, ButtonComponent, Menu } from 'obsidian';
import * as openpgp from 'openpgp';

interface PluginData {
  privateKey: string;
  publicKey: string;
  name: string;
  email: string;
  onboardingComplete: boolean;
}

const DEFAULT_DATA: PluginData = {
  privateKey: '',
  publicKey: '',
  name: '',
  email: '',
  onboardingComplete: false,
};

const SIGNATURE_DELIMITER = '\n\n---\n<!-- obs-pgp-signature -->\n';

export default class ObsPgpPlugin extends Plugin {
  data: PluginData;
  private ribbonIcon: HTMLElement | null = null;

  async onload() {
    const saved = await this.loadData();
    this.data = Object.assign({}, DEFAULT_DATA, saved);

    if (!this.data.onboardingComplete) {
      new OnboardingModal(this.app, this).open();
      return;
    }

    this.activate();
  }

  activate() {
    this.ribbonIcon = this.addRibbonIcon('pencil', 'Sign this note', () => {
      this.signNote();
    });

    // Status bar button
    const statusItem = this.addStatusBarItem();
    statusItem.setText('✍ Sign');
    statusItem.title = 'Sign this note with your PGP key';
    statusItem.style.cursor = 'pointer';
    statusItem.addEventListener('click', () => this.signNote());

    // Right-click context menu in editor
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu) => {
        menu.addItem((item) => {
          item
            .setTitle('Sign with PGP key')
            .setIcon('pencil')
            .onClick(() => this.signNote());
        });
      })
    );

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
  }

  async signNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice('No active note.'); return; }

    const editor: Editor = view.editor;
    let content = editor.getValue();

    const delimIdx = content.indexOf('\n\n---\n<!-- obs-pgp-signature -->');
    if (delimIdx !== -1) content = content.substring(0, delimIdx);

    try {
      const privateKeyObj = await openpgp.readPrivateKey({ armoredKey: this.data.privateKey });
      const message = await openpgp.createCleartextMessage({ text: content });
      const signed = await openpgp.sign({ message, signingKeys: privateKeyObj });
      editor.setValue(content + SIGNATURE_DELIMITER + signed);
      new Notice('Note signed.');
    } catch (e) {
      new Notice('Error signing note: ' + (e as Error).message);
    }
  }

  async verifyNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice('No active note.'); return; }

    const content = view.editor.getValue();
    const startMarker = '-----BEGIN PGP SIGNED MESSAGE-----';
    const endMarker = '-----END PGP SIGNATURE-----';
    const startIdx = content.indexOf(startMarker);
    if (startIdx === -1) { new Notice('No signature block found.'); return; }
    const endIdx = content.indexOf(endMarker, startIdx);
    if (endIdx === -1) { new Notice('Malformed signature block.'); return; }

    try {
      const publicKeyObj = await openpgp.readKey({ armoredKey: this.data.publicKey });
      const message = await openpgp.readCleartextMessage({
        cleartextMessage: content.substring(startIdx, endIdx + endMarker.length),
      });
      const result = await openpgp.verify({ message, verificationKeys: publicKeyObj });
      try {
        await result.signatures[0].verified;
        new Notice('Signature valid ✓');
      } catch {
        new Notice('Signature INVALID ✗');
      }
    } catch (e) {
      new Notice('Error verifying: ' + (e as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Onboarding — three steps, no key generated until identity is confirmed
// ---------------------------------------------------------------------------

class OnboardingModal extends Modal {
  private plugin: ObsPgpPlugin;
  private step = 1;
  private nameValue = '';
  private emailValue = '';

  constructor(app: App, plugin: ObsPgpPlugin) {
    super(app);
    this.plugin = plugin;
    this.modalEl.addClass('obs-pgp-onboarding');
  }

  onOpen() { this.renderStep(); }
  onClose() { this.contentEl.empty(); }

  private renderStep() {
    const { contentEl } = this;
    contentEl.empty();

    const wrap = contentEl.createDiv({ cls: 'obs-pgp-step' });

    wrap.createEl('p', {
      text: `Step ${this.step} of 4`,
      attr: { style: 'color: var(--text-muted); font-size: 0.8em; margin-bottom: 0.25em;' },
    });

    if (this.step === 1) this.renderWelcome(wrap);
    else if (this.step === 2) this.renderIdentity(wrap);
    else if (this.step === 3) this.renderBackup(wrap);
    else this.renderHowToSign(wrap);
  }

  private renderWelcome(wrap: HTMLElement) {
    wrap.createEl('h2', { text: 'Welcome to OBS PGP Signer' });
    wrap.createEl('p', {
      text: 'This plugin lets you digitally sign your notes using PGP — a widely trusted standard for proving that a document was written by you and has not been altered since you signed it.',
    });
    wrap.createEl('p', {
      text: 'Your signature is unique to you. Readers can use your public key to verify that a note genuinely came from you.',
    });
    wrap.createEl('p', {
      text: 'Setup takes about a minute. You will need a USB drive to safely back up your signing key.',
      attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
    });

    const footer = wrap.createDiv({ attr: { style: 'margin-top: 2em; text-align: right;' } });
    new ButtonComponent(footer)
      .setButtonText('Get started →')
      .setCta()
      .onClick(() => { this.step = 2; this.renderStep(); });
  }

  private renderIdentity(wrap: HTMLElement) {
    wrap.createEl('h2', { text: 'Your identity' });
    wrap.createEl('p', {
      text: 'Your name and email address are embedded in your signing key. This is how readers know the signature belongs to you. Use your real name and email so your readers can trust it.',
    });

    const nameLabel = wrap.createEl('label', { text: 'Full name', attr: { style: 'display:block; margin-top:1em; font-weight:600;' } });
    const nameInput = wrap.createEl('input', {
      attr: { type: 'text', placeholder: 'e.g. Jane Smith', style: 'width:100%; margin-top:4px; padding:6px; box-sizing:border-box;' },
    });
    nameInput.value = this.nameValue;

    const emailLabel = wrap.createEl('label', { text: 'Email address', attr: { style: 'display:block; margin-top:1em; font-weight:600;' } });
    const emailInput = wrap.createEl('input', {
      attr: { type: 'email', placeholder: 'e.g. jane@example.com', style: 'width:100%; margin-top:4px; padding:6px; box-sizing:border-box;' },
    });
    emailInput.value = this.emailValue;

    const errorEl = wrap.createEl('p', {
      attr: { style: 'color: var(--text-error); font-size:0.85em; min-height:1.2em; margin-top:0.5em;' },
    });

    const footer = wrap.createDiv({ attr: { style: 'margin-top: 2em; display:flex; justify-content:space-between;' } });

    new ButtonComponent(footer)
      .setButtonText('← Back')
      .onClick(() => { this.step = 1; this.renderStep(); });

    const nextBtn = new ButtonComponent(footer)
      .setButtonText('Next →')
      .setCta();

    nextBtn.onClick(async () => {
      const name = nameInput.value.trim();
      const email = emailInput.value.trim();
      this.nameValue = name;
      this.emailValue = email;

      if (!name) { errorEl.textContent = 'Please enter your full name.'; return; }
      if (!email || !email.includes('@')) { errorEl.textContent = 'Please enter a valid email address.'; return; }

      nextBtn.setDisabled(true).setButtonText('Generating key…');
      this.plugin.data.name = name;
      this.plugin.data.email = email;

      try {
        await this.plugin.generateKeypair();
        this.step = 3;
        this.renderStep();
      } catch (e) {
        errorEl.textContent = 'Failed to generate key: ' + (e as Error).message;
        nextBtn.setDisabled(false).setButtonText('Next →');
      }
    });
  }

  private renderBackup(wrap: HTMLElement) {
    wrap.createEl('h2', { text: 'Back up your signing key' });
    wrap.createEl('p', {
      text: 'Your signing key has been created. Now save it to a USB drive and store it somewhere safe.',
    });

    const list = wrap.createEl('ul', { attr: { style: 'margin: 0.75em 0 0.75em 1.5em;' } });
    list.createEl('li', { text: 'If you lose this key, you cannot sign from a new device.' });
    list.createEl('li', { text: 'Keep the private key file confidential — do not share it.' });
    list.createEl('li', { text: 'Your public key can be shared freely so others can verify your notes.' });

    const btnWrap = wrap.createDiv({ attr: { style: 'margin-top:1.5em; display:flex; gap:8px; flex-wrap:wrap;' } });

    new ButtonComponent(btnWrap)
      .setButtonText('Save private key (.asc)')
      .setCta()
      .onClick(() => {
        downloadTextFile('obs-pgp-private.asc', this.plugin.data.privateKey);
        new Notice('Private key saved — keep it safe!');
        savedPrivate = true;
        updateDone();
      });

    new ButtonComponent(btnWrap)
      .setButtonText('Save public key (.asc)')
      .onClick(() => {
        downloadTextFile('obs-pgp-public.asc', this.plugin.data.publicKey);
        new Notice('Public key saved.');
      });

    let savedPrivate = false;

    const hint = wrap.createEl('p', {
      text: 'Please save your private key before continuing.',
      attr: { style: 'color: var(--text-muted); font-size:0.85em; margin-top:0.75em;' },
    });

    const footer = wrap.createDiv({ attr: { style: 'margin-top: 2em; text-align:right;' } });
    const doneBtn = new ButtonComponent(footer)
      .setButtonText('Done — start signing')
      .setDisabled(true);

    const updateDone = () => {
      if (savedPrivate) {
        doneBtn.setDisabled(false).setCta();
        hint.textContent = 'Key saved. You are ready to sign your notes.';
        hint.style.color = 'var(--text-success)';
      }
    };

    doneBtn.onClick(() => {
      this.step = 4;
      this.renderStep();
    });
  }

  private renderHowToSign(wrap: HTMLElement) {
    wrap.createEl('h2', { text: 'You\'re all set — here\'s how to sign' });
    wrap.createEl('p', { text: 'There are three ways to sign any note:' });

    const list = wrap.createEl('ol', { attr: { style: 'margin: 0.75em 0 0.75em 1.5em; line-height: 2;' } });
    list.createEl('li', { text: '✍ Click the "Sign" button in the bottom status bar (always visible)' });
    list.createEl('li', { text: 'Right-click anywhere in a note → "Sign with PGP key"' });
    list.createEl('li', { text: 'Press Ctrl+P and type "Sign this note"' });

    wrap.createEl('p', {
      text: 'Signing adds a PGP signature block to the bottom of your note. Share the note and your public key with readers — they can use it to verify the note is genuinely yours.',
      attr: { style: 'margin-top: 1em; color: var(--text-muted); font-size: 0.9em;' },
    });

    const footer = wrap.createDiv({ attr: { style: 'margin-top: 2em; text-align: right;' } });
    new ButtonComponent(footer)
      .setButtonText('Start signing →')
      .setCta()
      .onClick(async () => {
        this.plugin.data.onboardingComplete = true;
        await this.plugin.savePluginData();
        this.close();
        this.plugin.activate();
        new Notice('OBS PGP Signer is ready.');
      });
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

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

    containerEl.createEl('p', {
      text: `Signing as: ${this.plugin.data.name} <${this.plugin.data.email}>`,
      attr: { style: 'color: var(--text-muted);' },
    });

    new Setting(containerEl)
      .setName('Import key from another device')
      .setDesc('Already have a key from another device? Import your private key (.asc) here to sign with the same identity.')
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

    new Setting(containerEl)
      .setName('Regenerate keypair')
      .setDesc('Creates a new key with your current name and email. Old signatures will no longer verify.')
      .addButton((btn) =>
        btn
          .setButtonText('Regenerate…')
          .setWarning()
          .onClick(() => {
            new ConfirmModal(
              this.app,
              'Regenerate keypair?',
              'This will create a new PGP keypair. Old signatures cannot be verified with the new key. Continue?',
              'Regenerate',
              async () => {
                await this.plugin.generateKeypair();
                new BackupReminderModal(this.app, this.plugin.data.privateKey, this.plugin.data.publicKey).open();
                this.display();
              }
            ).open();
          })
      );

    containerEl.createEl('h3', { text: 'Your public key', attr: { style: 'margin-top:2em;' } });
    containerEl.createEl('p', {
      text: 'Share this with readers so they can verify your signatures.',
      attr: { style: 'color: var(--text-muted); font-size:0.9em;' },
    });

    new Setting(containerEl)
      .addButton((btn) =>
        btn.setButtonText('Copy public key').onClick(() => {
          navigator.clipboard.writeText(this.plugin.data.publicKey);
          new Notice('Public key copied.');
        })
      )
      .addButton((btn) =>
        btn.setButtonText('Save public key (.asc)').onClick(() => {
          downloadTextFile('obs-pgp-public.asc', this.plugin.data.publicKey);
        })
      );

    const pubKeyArea = containerEl.createEl('textarea', {
      attr: { readonly: 'true', rows: '10', style: 'width:100%;font-family:monospace;font-size:11px;resize:vertical;margin-top:8px;' },
    });
    pubKeyArea.value = this.plugin.data.publicKey;

    containerEl.createEl('h3', { text: 'Private key backup', attr: { style: 'margin-top:2em;' } });
    new Setting(containerEl)
      .setDesc('Save to a USB drive and keep it safe.')
      .addButton((btn) =>
        btn.setButtonText('Save private key (.asc)').setCta().onClick(() => {
          downloadTextFile('obs-pgp-private.asc', this.plugin.data.privateKey);
          new Notice('Private key saved — keep it safe!');
        })
      );
  }
}

// ---------------------------------------------------------------------------
// Helper modals
// ---------------------------------------------------------------------------

class BackupReminderModal extends Modal {
  private privateKey: string;
  private publicKey: string;

  constructor(app: App, privateKey: string, publicKey: string) {
    super(app);
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Save your new key' });
    contentEl.createEl('p', { text: 'A new keypair was generated. Save it to your USB drive to replace the old backup.' });
    const btnDiv = contentEl.createDiv({ attr: { style: 'margin-top:1em; display:flex; gap:8px;' } });
    new ButtonComponent(btnDiv).setButtonText('Save private key (.asc)').setCta().onClick(() => {
      downloadTextFile('obs-pgp-private.asc', this.privateKey);
      new Notice('Private key saved.');
    });
    new ButtonComponent(btnDiv).setButtonText('Save public key (.asc)').onClick(() => {
      downloadTextFile('obs-pgp-public.asc', this.publicKey);
    });
    new ButtonComponent(btnDiv).setButtonText('Close').onClick(() => this.close());
  }

  onClose() { this.contentEl.empty(); }
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
    contentEl.createEl('p', { text: 'Paste the contents of your obs-pgp-private.asc file below.' });

    const textarea = contentEl.createEl('textarea', {
      attr: { rows: '14', placeholder: '-----BEGIN PGP PRIVATE KEY BLOCK-----\n...', style: 'width:100%;font-family:monospace;font-size:11px;resize:vertical;margin-top:8px;' },
    });

    const errorEl = contentEl.createEl('p', { attr: { style: 'color:var(--text-error);font-size:0.85em;min-height:1.2em;' } });

    const btnDiv = contentEl.createDiv({ attr: { style: 'margin-top:0.5em; display:flex; gap:8px;' } });
    const importBtn = new ButtonComponent(btnDiv).setButtonText('Import').setCta();
    importBtn.onClick(async () => {
      errorEl.textContent = '';
      const armoredKey = textarea.value.trim();
      if (!armoredKey) { errorEl.textContent = 'Please paste your private key.'; return; }
      try {
        const privateKeyObj = await openpgp.readPrivateKey({ armoredKey });
        const publicKey = privateKeyObj.toPublic().armor();
        this.close();
        this.onImport(armoredKey, publicKey);
      } catch (e) {
        errorEl.textContent = 'Could not read key: ' + (e as Error).message;
      }
    });
    new ButtonComponent(btnDiv).setButtonText('Cancel').onClick(() => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private body: string,
    private confirmLabel: string,
    private onConfirm: () => void,
  ) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.title });
    contentEl.createEl('p', { text: this.body });
    const btnDiv = contentEl.createDiv({ attr: { style: 'margin-top:1em; display:flex; gap:8px;' } });
    new ButtonComponent(btnDiv).setButtonText(this.confirmLabel).setWarning().onClick(() => { this.close(); this.onConfirm(); });
    new ButtonComponent(btnDiv).setButtonText('Cancel').onClick(() => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

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

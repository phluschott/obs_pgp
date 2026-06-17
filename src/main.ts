import { Plugin, PluginSettingTab, App, Setting, Notice, MarkdownView, Modal, ButtonComponent, Menu, TFile } from 'obsidian';
import * as openpgp from 'openpgp';

interface PluginData {
  privateKey: string;  // armored, passphrase-encrypted
  publicKey: string;
  name: string;
  email: string;
  onboardingComplete: boolean;
  pgpLogInAscFolder: boolean;
}

const DEFAULT_DATA: PluginData = {
  privateKey: '',
  publicKey: '',
  name: '',
  email: '',
  onboardingComplete: false,
  pgpLogInAscFolder: false,
};

const ASC_FOLDER = '.asc';
const LOG_FILENAME = 'PGP Log.md';

export default class ObsPgpPlugin extends Plugin {
  data: PluginData;

  // Decrypted key cached for the session — never written to disk, cleared on unload
  private sessionKey: openpgp.PrivateKey | null = null;

  async onload() {
    const saved = await this.loadData();
    this.data = Object.assign({}, DEFAULT_DATA, saved);

    if (!this.data.onboardingComplete) {
      new OnboardingModal(this.app, this).open();
      return;
    }

    await this.ensureAscFolder();
    this.activate();
  }

  onunload() {
    this.sessionKey = null;
  }

  // Tracks files currently being written by the plugin to avoid modify-event loops
  private modifyingFiles = new Set<string>();

  activate() {
    this.addRibbonIcon('pencil', 'Sign this note', () => this.signNote());

    const statusItem = this.addStatusBarItem();
    statusItem.setText('✍ Sign');
    statusItem.title = 'Sign this note with your PGP key';
    statusItem.style.cursor = 'pointer';
    statusItem.addEventListener('click', () => this.signNote());

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu) => {
        menu.addItem((item) =>
          item.setTitle('Sign with PGP key').setIcon('pencil').onClick(() => this.signNote())
        );
      })
    );

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file) => {
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) =>
            item.setTitle('Sign with PGP key').setIcon('pencil').onClick(() => this.signFile(file))
          );
        }
      })
    );

    // Clear pgp_signed and refresh log when a signed note is edited
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        if (this.modifyingFiles.has(file.path)) return;
        const content = await this.app.vault.read(file);
        if (/^pgp_signed:\s*true/m.test(content)) {
          this.modifyingFiles.add(file.path);
          try {
            await this.app.vault.modify(file, content.replace(/^pgp_signed:\s*true/m, 'pgp_signed: false'));
          } finally {
            this.modifyingFiles.delete(file.path);
          }
          await this.regenerateLog();
        }
      })
    );

    this.addCommand({ id: 'sign-note', name: 'Sign this note', callback: () => this.signNote() });
    this.addCommand({ id: 'verify-signature', name: 'Verify signature', callback: () => this.verifyNote() });

    this.addSettingTab(new ObsPgpSettingTab(this.app, this));
  }

  async savePluginData() {
    await this.saveData(this.data);
  }

  async generateKeypair(passphrase: string) {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: 'rsa',
      rsaBits: 2048,
      userIDs: [{ name: this.data.name, email: this.data.email }],
      passphrase,
      format: 'armored',
    });
    this.data.privateKey = privateKey;
    this.data.publicKey = publicKey;
    await this.savePluginData();
  }

  async ensureAscFolder() {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(ASC_FOLDER))) {
      await adapter.mkdir(ASC_FOLDER);
    }
  }

  ascPathFor(notePath: string): string {
    return `${ASC_FOLDER}/${notePath}.asc`;
  }

  logPath(): string {
    return this.data.pgpLogInAscFolder
      ? `${ASC_FOLDER}/${LOG_FILENAME}`
      : LOG_FILENAME;
  }

  async moveLog(toAscFolder: boolean) {
    const from = toAscFolder ? LOG_FILENAME : `${ASC_FOLDER}/${LOG_FILENAME}`;
    const to   = toAscFolder ? `${ASC_FOLDER}/${LOG_FILENAME}` : LOG_FILENAME;
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(from)) {
      const contents = await adapter.read(from);
      await adapter.write(to, contents);
      await adapter.remove(from);
    }
    this.data.pgpLogInAscFolder = toAscFolder;
    await this.savePluginData();
  }

  // Returns the session-cached decrypted key, prompting for passphrase if needed
  async getSigningKey(): Promise<openpgp.PrivateKey> {
    if (this.sessionKey) return this.sessionKey;

    return new Promise((resolve, reject) => {
      new PassphraseModal(
        this.app,
        async (passphrase) => {
          try {
            const privateKeyObj = await openpgp.readPrivateKey({ armoredKey: this.data.privateKey });
            const decrypted = await openpgp.decryptKey({ privateKey: privateKeyObj, passphrase });
            this.sessionKey = decrypted;
            resolve(decrypted);
          } catch {
            reject(new Error('Incorrect passphrase. Please try again.'));
          }
        },
        () => reject(new Error('Cancelled'))
      ).open();
    });
  }

  async signNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) { new Notice('No active note.'); return; }
    await this.signFile(view.file);
  }

  async signFile(file: TFile) {
    let signingKey: openpgp.PrivateKey;
    try {
      signingKey = await this.getSigningKey();
    } catch (e) {
      if ((e as Error).message !== 'Cancelled') new Notice((e as Error).message);
      return;
    }

    try {
      const content = await this.app.vault.read(file);
      const message = await openpgp.createCleartextMessage({ text: content });
      const signed = await openpgp.sign({ message, signingKeys: signingKey });

      const ascPath = this.ascPathFor(file.path);
      const ascDir = ascPath.substring(0, ascPath.lastIndexOf('/'));
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(ascDir))) await adapter.mkdir(ascDir);
      await adapter.write(ascPath, signed);

      await this.stampFrontmatter(file);
      await this.regenerateLog();

      new Notice(`"${file.basename}" signed.`);
    } catch (e) {
      new Notice('Error signing: ' + (e as Error).message);
    }
  }

  async verifyNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) { new Notice('No active note.'); return; }

    const file = view.file;
    const ascPath = this.ascPathFor(file.path);
    const adapter = this.app.vault.adapter;

    if (!(await adapter.exists(ascPath))) {
      new Notice('No signature found for this note.');
      return;
    }

    try {
      const armoredSigned = await adapter.read(ascPath);
      const publicKeyObj = await openpgp.readKey({ armoredKey: this.data.publicKey });
      const message = await openpgp.readCleartextMessage({ cleartextMessage: armoredSigned });
      const result = await openpgp.verify({ message, verificationKeys: publicKeyObj });

      try {
        await result.signatures[0].verified;
        new Notice('Signature valid ✓ — note has not been altered since signing.');
      } catch {
        new Notice('Signature INVALID ✗ — note may have been modified after signing.');
      }
    } catch (e) {
      new Notice('Error verifying: ' + (e as Error).message);
    }
  }

  private async stampFrontmatter(file: TFile) {
    const content = await this.app.vault.read(file);
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let updated: string;

    if (fmMatch) {
      if (/^pgp_signed:/m.test(fmMatch[1])) {
        updated = content.replace(/^pgp_signed:.*$/m, 'pgp_signed: true');
      } else {
        updated = content.replace(/^---\r?\n([\s\S]*?)\r?\n---/, `---\n$1\npgp_signed: true\n---`);
      }
    } else {
      updated = `---\npgp_signed: true\n---\n\n${content}`;
    }

    this.modifyingFiles.add(file.path);
    try {
      await this.app.vault.modify(file, updated);
    } finally {
      this.modifyingFiles.delete(file.path);
    }
  }

  async regenerateLog() {
    const signed: TFile[] = [];
    const modified: TFile[] = [];
    const logPath = this.logPath();

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path === logPath) continue;
      const status = this.app.metadataCache.getFileCache(file)?.frontmatter?.pgp_signed;
      if (status === true) signed.push(file);
      else if (status === false) modified.push(file);
    }

    const lines = [
      '# PGP Log',
      '',
      'Signature files are stored in the `.asc` folder.',
      '',
      '> **If a note appears under "Edited since signing"** it has been changed after it was signed.',
      '> The signature on file is for an earlier version of the note. Re-sign it to bring it up to date.',
      '',
      `## ✓ Signed (${signed.length})`,
      signed.length === 0
        ? '_No signed notes yet._'
        : signed.map(f => `- [[${f.path.replace(/\.md$/, '')}]]`).join('\n'),
      '',
      `## ✎ Edited since signing (${modified.length})`,
      modified.length === 0
        ? '_None — all signed notes are up to date._'
        : modified.map(f => `- [[${f.path.replace(/\.md$/, '')}]]`).join('\n'),
      '',
      `_Last updated: ${new Date().toLocaleString()}_`,
    ];

    this.modifyingFiles.add(logPath);
    try {
      await this.app.vault.adapter.write(logPath, lines.join('\n') + '\n');
    } finally {
      this.modifyingFiles.delete(logPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Onboarding — 4 steps
// ---------------------------------------------------------------------------

class OnboardingModal extends Modal {
  private plugin: ObsPgpPlugin;
  private step = 1;
  private nameValue = '';
  private emailValue = '';
  private passphrase = '';

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
      text: 'Your notes are never modified. Signatures are stored invisibly in a hidden .asc folder at the root of your vault, so your writing stays clean.',
      attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
    });
    wrap.createEl('p', {
      text: 'Setup takes about a minute.',
      attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
    });
    const footer = wrap.createDiv({ attr: { style: 'margin-top: 2em; text-align: right;' } });
    new ButtonComponent(footer).setButtonText('Get started →').setCta()
      .onClick(() => { this.step = 2; this.renderStep(); });
  }

  private renderIdentity(wrap: HTMLElement) {
    wrap.createEl('h2', { text: 'Your identity & passphrase' });
    wrap.createEl('p', {
      text: 'Your name and email are embedded in your signing key so readers know who signed it. Your passphrase encrypts the key — even if your vault syncs to the cloud, the key is useless without it.',
    });

    wrap.createEl('label', { text: 'Full name', attr: { style: 'display:block; margin-top:1em; font-weight:600;' } });
    const nameInput = wrap.createEl('input', {
      attr: { type: 'text', placeholder: 'e.g. Jane Smith', style: 'width:100%; margin-top:4px; padding:6px; box-sizing:border-box;' },
    });
    nameInput.value = this.nameValue;

    wrap.createEl('label', { text: 'Email address', attr: { style: 'display:block; margin-top:1em; font-weight:600;' } });
    const emailInput = wrap.createEl('input', {
      attr: { type: 'email', placeholder: 'e.g. jane@example.com', style: 'width:100%; margin-top:4px; padding:6px; box-sizing:border-box;' },
    });
    emailInput.value = this.emailValue;

    wrap.createEl('label', { text: 'Passphrase', attr: { style: 'display:block; margin-top:1em; font-weight:600;' } });
    wrap.createEl('p', {
      text: 'Choose something memorable but hard to guess — you will enter this each time you open Obsidian.',
      attr: { style: 'font-size:0.85em; color:var(--text-muted); margin:2px 0 4px 0;' },
    });
    const passInput = wrap.createEl('input', {
      attr: { type: 'password', placeholder: 'Passphrase', style: 'width:100%; padding:6px; box-sizing:border-box;' },
    });

    wrap.createEl('label', { text: 'Confirm passphrase', attr: { style: 'display:block; margin-top:0.75em; font-weight:600;' } });
    const confirmInput = wrap.createEl('input', {
      attr: { type: 'password', placeholder: 'Repeat passphrase', style: 'width:100%; padding:6px; box-sizing:border-box; margin-top:4px;' },
    });

    // Passphrase strength hint
    const strengthEl = wrap.createEl('p', { attr: { style: 'font-size:0.8em; min-height:1.2em; margin-top:4px;' } });
    passInput.addEventListener('input', () => {
      const { label, color } = passphraseStrength(passInput.value);
      strengthEl.textContent = passInput.value ? `Strength: ${label}` : '';
      strengthEl.style.color = color;
    });

    const errorEl = wrap.createEl('p', {
      attr: { style: 'color: var(--text-error); font-size:0.85em; min-height:1.2em; margin-top:0.5em;' },
    });

    const footer = wrap.createDiv({ attr: { style: 'margin-top: 2em; display:flex; justify-content:space-between;' } });
    new ButtonComponent(footer).setButtonText('← Back').onClick(() => { this.step = 1; this.renderStep(); });

    const nextBtn = new ButtonComponent(footer).setButtonText('Generate key →').setCta();
    nextBtn.onClick(async () => {
      const name = nameInput.value.trim();
      const email = emailInput.value.trim();
      const pass = passInput.value;
      const confirm = confirmInput.value;

      if (!name) { errorEl.textContent = 'Please enter your full name.'; return; }
      if (!email || !email.includes('@')) { errorEl.textContent = 'Please enter a valid email address.'; return; }
      if (pass.length < 8) { errorEl.textContent = 'Passphrase must be at least 8 characters.'; return; }
      if (pass !== confirm) { errorEl.textContent = 'Passphrases do not match.'; return; }

      this.nameValue = name;
      this.emailValue = email;
      this.passphrase = pass;

      nextBtn.setDisabled(true).setButtonText('Generating key…');
      this.plugin.data.name = name;
      this.plugin.data.email = email;

      try {
        await this.plugin.generateKeypair(pass);
        this.step = 3;
        this.renderStep();
      } catch (e) {
        errorEl.textContent = 'Failed to generate key: ' + (e as Error).message;
        nextBtn.setDisabled(false).setButtonText('Generate key →');
      }
    });
  }

  private renderBackup(wrap: HTMLElement) {
    wrap.createEl('h2', { text: 'Save your keys somewhere safe' });
    wrap.createEl('p', {
      text: 'Your keys have been generated. They are not written to any file — copy them now to a password manager, USB drive, or other safe location. You will not see them again after this step.',
    });

    // Private key
    wrap.createEl('p', { text: 'Private key (keep this secret):', attr: { style: 'font-weight:600; margin-top:1.25em; margin-bottom:4px;' } });
    const privArea = wrap.createEl('textarea', {
      attr: { readonly: 'true', rows: '7', style: 'width:100%;font-family:monospace;font-size:10px;resize:none;box-sizing:border-box;' },
    });
    privArea.value = this.plugin.data.privateKey;

    let copiedPrivate = false;
    const copyPrivBtn = wrap.createEl('button', { text: 'Copy private key', attr: { style: 'margin-top:4px;' } });
    copyPrivBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this.plugin.data.privateKey);
      copyPrivBtn.textContent = 'Copied ✓';
      copiedPrivate = true;
      updateNext();
    });

    // Public key
    wrap.createEl('p', { text: 'Public key (share this with readers):', attr: { style: 'font-weight:600; margin-top:1.25em; margin-bottom:4px;' } });
    const pubArea = wrap.createEl('textarea', {
      attr: { readonly: 'true', rows: '5', style: 'width:100%;font-family:monospace;font-size:10px;resize:none;box-sizing:border-box;' },
    });
    pubArea.value = this.plugin.data.publicKey;

    const copyPubBtn = wrap.createEl('button', { text: 'Copy public key', attr: { style: 'margin-top:4px;' } });
    copyPubBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this.plugin.data.publicKey);
      copyPubBtn.textContent = 'Copied ✓';
    });

    const hint = wrap.createEl('p', {
      text: 'Copy your private key before continuing.',
      attr: { style: 'color: var(--text-muted); font-size:0.85em; margin-top:0.75em;' },
    });

    const footer = wrap.createDiv({ attr: { style: 'margin-top: 1.5em; text-align:right;' } });
    const nextBtn = new ButtonComponent(footer).setButtonText('Next →').setDisabled(true);

    const updateNext = () => {
      if (copiedPrivate) {
        nextBtn.setDisabled(false).setCta();
        hint.textContent = 'Private key copied. Keep it safe — your passphrase is needed to use it.';
        hint.style.color = 'var(--text-success)';
      }
    };

    nextBtn.onClick(() => { this.step = 4; this.renderStep(); });
  }

  private renderHowToSign(wrap: HTMLElement) {
    wrap.createEl('h2', { text: 'You\'re all set — here\'s how to sign' });
    wrap.createEl('p', { text: 'There are three ways to sign any note:' });

    const list = wrap.createEl('ol', { attr: { style: 'margin: 0.75em 0 0.75em 1.5em; line-height: 2;' } });
    list.createEl('li', { text: '✍ Click the "Sign" button in the bottom status bar (always visible)' });
    list.createEl('li', { text: 'Right-click a note in the file explorer → "Sign with PGP key"' });
    list.createEl('li', { text: 'Press Ctrl+P and type "Sign this note"' });

    wrap.createEl('p', { text: 'About your passphrase', attr: { style: 'font-weight:600; margin-top:1.25em;' } });
    wrap.createEl('p', {
      text: 'The first time you sign in each Obsidian session, you will be asked for your passphrase. It is only held in memory while Obsidian is open — never written to disk.',
      attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
    });

    wrap.createEl('p', { text: 'Where are signatures stored?', attr: { style: 'font-weight:600; margin-top:1.25em;' } });
    wrap.createEl('p', {
      text: 'Every signature is saved as a hidden file inside the .asc folder at the root of your vault. A PGP Log note at the vault root lists all your signed notes and their current status.',
      attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
    });

    wrap.createEl('p', { text: 'What happens if I edit a signed note?', attr: { style: 'font-weight:600; margin-top:1.25em;' } });
    wrap.createEl('p', {
      text: 'The moment you make a change, the note\'s pgp_signed property automatically flips to false — a clear signal that the current version is not signed. The PGP Log updates instantly to move it into the "Edited since signing" section. Simply re-sign the note to bring the signature up to date.',
      attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
    });

    const footer = wrap.createDiv({ attr: { style: 'margin-top: 2em; text-align: right;' } });
    new ButtonComponent(footer).setButtonText('Start signing →').setCta().onClick(async () => {
      this.plugin.data.onboardingComplete = true;
      await this.plugin.savePluginData();
      await this.plugin.ensureAscFolder();
      this.close();
      this.plugin.activate();
      new Notice('OBS PGP Signer is ready.');
    });
  }
}

// ---------------------------------------------------------------------------
// Passphrase prompt — shown once per session before first sign
// ---------------------------------------------------------------------------

class PassphraseModal extends Modal {
  constructor(
    app: App,
    private onSubmit: (passphrase: string) => void,
    private onCancel: () => void,
  ) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Enter your passphrase' });
    contentEl.createEl('p', {
      text: 'Your passphrase is needed to unlock your signing key for this session.',
      attr: { style: 'color:var(--text-muted); font-size:0.9em;' },
    });

    const input = contentEl.createEl('input', {
      attr: { type: 'password', placeholder: 'Passphrase', style: 'width:100%; padding:6px; box-sizing:border-box; margin-top:8px;' },
    });

    const errorEl = contentEl.createEl('p', {
      attr: { style: 'color:var(--text-error); font-size:0.85em; min-height:1.2em; margin-top:4px;' },
    });

    const btnDiv = contentEl.createDiv({ attr: { style: 'margin-top:1em; display:flex; gap:8px;' } });
    const unlockBtn = new ButtonComponent(btnDiv).setButtonText('Unlock').setCta();

    const submit = () => {
      const val = input.value;
      if (!val) { errorEl.textContent = 'Please enter your passphrase.'; return; }
      unlockBtn.setDisabled(true).setButtonText('Unlocking…');
      this.close();
      this.onSubmit(val);
    };

    unlockBtn.onClick(submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    new ButtonComponent(btnDiv).setButtonText('Cancel').onClick(() => { this.close(); this.onCancel(); });

    // Focus the input after the modal opens
    setTimeout(() => input.focus(), 50);
  }

  onClose() { this.contentEl.empty(); }
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

    // Storage info box
    const infoBox = containerEl.createDiv({
      attr: { style: 'background:var(--background-secondary); border-radius:6px; padding:12px 16px; margin:1em 0;' },
    });
    infoBox.createEl('p', { text: 'How signatures work', attr: { style: 'font-weight:600; margin:0 0 6px 0;' } });
    infoBox.createEl('p', {
      text: 'Signature files (.asc) are saved in the .asc folder at the root of your vault — your notes are never modified by signing.',
      attr: { style: 'margin:0 0 6px 0; font-size:0.9em; color:var(--text-muted);' },
    });
    infoBox.createEl('p', {
      text: 'The PGP Log lists all signed notes and their current status. If you edit a signed note, its pgp_signed property automatically flips to false and the PGP Log moves it to the "Edited since signing" section — a clear signal that the current version is not covered by the signature. Re-sign the note to update it.',
      attr: { style: 'margin:0; font-size:0.9em; color:var(--text-muted);' },
    });

    new Setting(containerEl)
      .setName('Move PGP Log inside .asc folder')
      .setDesc(
        this.plugin.data.pgpLogInAscFolder
          ? 'PGP Log is currently stored in .asc/PGP Log.md — hidden from your vault file list.'
          : 'PGP Log is currently at the vault root (PGP Log.md). Toggle to move it inside .asc so it stays out of your way.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.data.pgpLogInAscFolder).onChange(async (value) => {
          await this.plugin.moveLog(value);
          new Notice(value ? 'PGP Log moved to .asc folder.' : 'PGP Log moved to vault root.');
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('Lock session key')
      .setDesc('Clears the passphrase from memory. You will be prompted again on the next sign.')
      .addButton((btn) =>
        btn.setButtonText('Lock').onClick(() => {
          (this.plugin as any).sessionKey = null;
          new Notice('Session key cleared — you will be prompted for your passphrase next time.');
        })
      );

    new Setting(containerEl)
      .setName('Import key from another device')
      .setDesc('Paste your encrypted private key to use the same signing identity on this device.')
      .addButton((btn) =>
        btn.setButtonText('Import key…').onClick(() => {
          new ImportKeyModal(this.app, async (privateKey, publicKey) => {
            this.plugin.data.privateKey = privateKey;
            this.plugin.data.publicKey = publicKey;
            (this.plugin as any).sessionKey = null;
            await this.plugin.savePluginData();
            new Notice('Key imported. You will be prompted for your passphrase on the next sign.');
            this.display();
          }).open();
        })
      );

    new Setting(containerEl)
      .setName('Regenerate keypair')
      .setDesc('Creates a new key. Old signatures will no longer verify.')
      .addButton((btn) =>
        btn.setButtonText('Regenerate…').setWarning().onClick(() => {
          new ConfirmModal(
            this.app,
            'Regenerate keypair?',
            'This will create a new PGP keypair. Old signatures cannot be verified with the new key. Continue?',
            'Regenerate',
            () => new RegenerateModal(this.app, this.plugin, () => this.display()).open()
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
      );

    const pubKeyArea = containerEl.createEl('textarea', {
      attr: { readonly: 'true', rows: '8', style: 'width:100%;font-family:monospace;font-size:11px;resize:vertical;margin-top:8px;' },
    });
    pubKeyArea.value = this.plugin.data.publicKey;

    containerEl.createEl('h3', { text: 'Private key backup', attr: { style: 'margin-top:2em;' } });
    containerEl.createEl('p', {
      text: 'This is your passphrase-encrypted private key. Copy it to a password manager or USB drive. It is useless without your passphrase.',
      attr: { style: 'color: var(--text-muted); font-size:0.9em;' },
    });

    new Setting(containerEl)
      .addButton((btn) =>
        btn.setButtonText('Copy encrypted private key').setCta().onClick(() => {
          navigator.clipboard.writeText(this.plugin.data.privateKey);
          new Notice('Encrypted private key copied.');
        })
      );

    const privKeyArea = containerEl.createEl('textarea', {
      attr: { readonly: 'true', rows: '8', style: 'width:100%;font-family:monospace;font-size:11px;resize:vertical;margin-top:8px;' },
    });
    privKeyArea.value = this.plugin.data.privateKey;
  }
}

// ---------------------------------------------------------------------------
// Helper modals
// ---------------------------------------------------------------------------

class RegenerateModal extends Modal {
  constructor(app: App, private plugin: ObsPgpPlugin, private onDone: () => void) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Choose a passphrase for the new key' });

    contentEl.createEl('label', { text: 'New passphrase', attr: { style: 'display:block; font-weight:600; margin-top:1em;' } });
    const passInput = contentEl.createEl('input', {
      attr: { type: 'password', placeholder: 'Passphrase', style: 'width:100%; padding:6px; box-sizing:border-box; margin-top:4px;' },
    });
    const strengthEl = contentEl.createEl('p', { attr: { style: 'font-size:0.8em; min-height:1.2em; margin-top:4px;' } });
    passInput.addEventListener('input', () => {
      const { label, color } = passphraseStrength(passInput.value);
      strengthEl.textContent = passInput.value ? `Strength: ${label}` : '';
      strengthEl.style.color = color;
    });

    contentEl.createEl('label', { text: 'Confirm passphrase', attr: { style: 'display:block; font-weight:600; margin-top:0.75em;' } });
    const confirmInput = contentEl.createEl('input', {
      attr: { type: 'password', placeholder: 'Repeat passphrase', style: 'width:100%; padding:6px; box-sizing:border-box; margin-top:4px;' },
    });

    const errorEl = contentEl.createEl('p', { attr: { style: 'color:var(--text-error); font-size:0.85em; min-height:1.2em;' } });

    const btnDiv = contentEl.createDiv({ attr: { style: 'margin-top:1em; display:flex; gap:8px;' } });
    const genBtn = new ButtonComponent(btnDiv).setButtonText('Generate').setCta();
    genBtn.onClick(async () => {
      const pass = passInput.value;
      const confirm = confirmInput.value;
      if (pass.length < 8) { errorEl.textContent = 'Passphrase must be at least 8 characters.'; return; }
      if (pass !== confirm) { errorEl.textContent = 'Passphrases do not match.'; return; }
      genBtn.setDisabled(true).setButtonText('Generating…');
      try {
        await this.plugin.generateKeypair(pass);
        (this.plugin as any).sessionKey = null;
        new Notice('New keypair generated.');
        this.close();
        this.onDone();
      } catch (e) {
        errorEl.textContent = 'Failed: ' + (e as Error).message;
        genBtn.setDisabled(false).setButtonText('Generate');
      }
    });
    new ButtonComponent(btnDiv).setButtonText('Cancel').onClick(() => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

class ImportKeyModal extends Modal {
  constructor(app: App, private onImport: (privateKey: string, publicKey: string) => void) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Import existing key' });
    contentEl.createEl('p', {
      text: 'Paste the encrypted private key you copied during setup. You will be prompted for its passphrase the next time you sign.',
    });

    const textarea = contentEl.createEl('textarea', {
      attr: { rows: '12', placeholder: '-----BEGIN PGP PRIVATE KEY BLOCK-----\n...', style: 'width:100%;font-family:monospace;font-size:11px;resize:vertical;margin-top:8px;' },
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
    new ButtonComponent(btnDiv).setButtonText(this.confirmLabel).setWarning()
      .onClick(() => { this.close(); this.onConfirm(); });
    new ButtonComponent(btnDiv).setButtonText('Cancel').onClick(() => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function passphraseStrength(pass: string): { label: string; color: string } {
  if (pass.length < 8)  return { label: 'Too short', color: 'var(--text-error)' };
  if (pass.length < 12) return { label: 'Weak', color: 'orange' };
  const hasUpper = /[A-Z]/.test(pass);
  const hasLower = /[a-z]/.test(pass);
  const hasDigit = /[0-9]/.test(pass);
  const hasSymbol = /[^A-Za-z0-9]/.test(pass);
  const variety = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
  if (pass.length >= 16 && variety >= 3) return { label: 'Strong', color: 'var(--text-success)' };
  if (pass.length >= 12 && variety >= 2) return { label: 'Good', color: 'var(--color-green)' };
  return { label: 'Fair', color: 'orange' };
}

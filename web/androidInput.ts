import type { Terminal } from '@xterm/xterm';

/** Translate Gboard's editable textarea into terminal edits, not whole phrases. */
export class AndroidInput {
  private value = '';
  private caret = 0;
  private composing = false;
  private pending: number | null = null;
  private readonly abort = new AbortController();
  private readonly textarea: HTMLTextAreaElement;
  private readonly view: HTMLElement | null;
  private readonly render;

  constructor(
    private readonly term: Terminal,
    private readonly emit: (data: string) => boolean,
    private readonly composition: (active: boolean) => void,
  ) {
    this.textarea = term.textarea!;
    this.view = term.element!.querySelector('.composition-view');
    const listen = (name: string, fn: EventListener): void => {
      // Use the ancestor capture phase: xterm already has textarea capture
      // listeners, so another listener on the textarea would run too late.
      term.element!.addEventListener(name, (event) => {
        if (event.target === this.textarea) fn(event);
      }, { capture: true, signal: this.abort.signal });
    };
    listen('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (e.keyCode === 229 || e.isComposing || e.key === 'Unidentified' || e.key === 'Process') {
        // Keep the browser's default edit; prevent xterm's deferred 229 diff.
        e.stopImmediatePropagation();
      } else if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) {
        // Flush a final IME edit before Enter, arrows, Backspace or hardware
        // typing. Those native terminal keys invalidate Gboard's local context.
        this.reset();
      }
    });
    listen('keyup', (event) => {
      const e = event as KeyboardEvent;
      if (e.keyCode === 229 || e.key === 'Unidentified' || e.key === 'Process') event.stopImmediatePropagation();
    });
    listen('compositionstart', (event) => {
      event.stopImmediatePropagation();
      this.finishPending();
      this.composing = true;
      this.composition(true);
      this.show('');
    });
    listen('compositionupdate', (event) => {
      event.stopImmediatePropagation();
      this.show((event as CompositionEvent).data);
    });
    listen('compositionend', (event) => {
      event.stopImmediatePropagation();
      // Chrome can update value in the following input/default action. Wait
      // one tick unless that input, Enter or a new composition flushes first.
      this.composing = false;
      this.hide();
      this.pending = window.setTimeout(() => this.finishPending(), 0);
    });
    listen('input', (event) => {
      event.stopImmediatePropagation();
      const e = event as InputEvent;
      if (this.composing) return;
      if (!this.value && !this.textarea.value && e.inputType.startsWith('delete')) {
        // Gboard can request a deletion with 229 even when the local context
        // was reset by an arrow, paste or Enter. The shell still has history.
        this.emit(e.inputType === 'deleteContentForward' ? '\x1b[3~' : '\x7f');
      } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
        // A 229-only software Enter may insert a newline instead of a keydown.
        this.textarea.value = this.textarea.value.replace(/\r?\n$/, '');
        this.apply();
        this.emit('\r');
        this.clear();
      } else if (this.pending !== null) {
        this.finishPending();
      } else {
        this.apply();
      }
    });
    listen('paste', () => this.reset());
    listen('blur', () => this.reset());
    this.render = term.onRender(() => {
      if (this.composing) this.positionView();
    });
  }

  /** Commit before an external key/paste and discard only browser IME context. */
  reset(): void {
    if (this.pending !== null) this.finishPending();
    else if (this.composing) {
      this.composing = false;
      this.apply();
      this.hide();
      this.composition(false);
    }
    this.clear();
  }

  private clear(): void {
    this.value = '';
    this.caret = 0;
    this.textarea.value = '';
  }

  private finishPending(): void {
    if (this.pending === null) return;
    window.clearTimeout(this.pending);
    this.pending = null;
    this.apply();
    this.composition(false);
  }

  private apply(): void {
    const next = this.textarea.value;
    const oldChars = Array.from(this.value);
    const newChars = Array.from(next);
    const nextCaret = Array.from(next.slice(0, this.textarea.selectionStart)).length;
    let prefix = 0;
    while (prefix < oldChars.length && prefix < newChars.length && oldChars[prefix] === newChars[prefix]) prefix++;
    let suffix = 0;
    while (suffix < oldChars.length - prefix && suffix < newChars.length - prefix &&
      oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]) suffix++;
    const oldEnd = oldChars.length - suffix;
    const newEnd = newChars.length - suffix;
    const move = (from: number, to: number): string => {
      const prefix = this.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
      return (prefix + (to < from ? 'D' : 'C')).repeat(Math.abs(to - from));
    };
    let data = '';
    if (next !== this.value) {
      data = move(this.caret, oldEnd) + '\x7f'.repeat(oldEnd - prefix) +
        newChars.slice(prefix, newEnd).join('') + move(newEnd, nextCaret);
    } else {
      data = move(this.caret, nextCaret);
    }
    if (data && !this.emit(data)) {
      // Never let text dropped during disconnection become a future deletion
      // against the real shell. Uncommitted composition is retained until here.
      this.clear();
      return;
    }
    this.value = next;
    this.caret = nextCaret;
  }

  private show(text: string): void {
    if (!this.view) return;
    this.view.textContent = text;
    this.view.classList.add('active');
    this.positionView();
  }

  private positionView(): void {
    const screen = this.term.element!.querySelector('.xterm-screen');
    if (!this.view || !screen || !this.term.cols || !this.term.rows) return;
    const rect = screen.getBoundingClientRect();
    const buffer = this.term.buffer.active;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    const cellH = rect.height / this.term.rows;
    this.view.style.left = `${Math.min(buffer.cursorX, this.term.cols - 1) * rect.width / this.term.cols}px`;
    this.view.style.top = `${row * cellH}px`;
    this.view.style.height = this.view.style.lineHeight = `${cellH}px`;
    this.view.style.fontFamily = this.term.options.fontFamily ?? '';
    this.view.style.fontSize = `${this.term.options.fontSize}px`;
  }

  private hide(): void {
    this.view?.classList.remove('active');
  }

  dispose(): void {
    if (this.pending !== null) window.clearTimeout(this.pending);
    this.abort.abort();
    this.render.dispose();
    this.hide();
  }
}

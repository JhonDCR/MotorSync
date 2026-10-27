import { ChangeDetectionStrategy, Component, ElementRef, output, signal, viewChild } from '@angular/core';
import type { ImageUpload } from '../checkin.service';
import { canvasToPng } from '../image-utils';

/** Touch signature pad: draws with pointer events and emits the PNG after every finished stroke. */
@Component({
  selector: 'app-signature-pad',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas
      #canvas
      class="pad"
      width="600"
      height="200"
      role="img"
      aria-label="Área de firma del cliente"
      (pointerdown)="start($event)"
      (pointermove)="move($event)"
      (pointerup)="end()"
      (pointerleave)="end()"
    ></canvas>
    <button type="button" class="action" [disabled]="!hasInk()" (click)="clear()">Borrar firma</button>
  `,
  styles: `
    :host {
      display: block;
    }
    .pad {
      display: block;
      width: 100%;
      max-width: 600px;
      aspect-ratio: 3 / 1;
      border: 1px solid #595959;
      border-radius: 4px;
      background: #ffffff;
      touch-action: none;
    }
    .action {
      min-height: 44px;
      min-width: 44px;
      margin-top: 0.5rem;
      padding: 0 1rem;
      font: inherit;
    }
    .action:focus-visible {
      outline: 3px solid #f1c232;
      outline-offset: 2px;
    }
  `,
})
export class SignaturePadComponent {
  /** PNG of the signature, or null when it is cleared. */
  readonly signed = output<ImageUpload | null>();

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly hasInk = signal(false);
  private drawing = false;

  private context(): CanvasRenderingContext2D | null {
    return this.canvas().nativeElement.getContext('2d');
  }

  private point(event: PointerEvent): { x: number; y: number } {
    const el = this.canvas().nativeElement;
    const rect = el.getBoundingClientRect();
    const sx = rect.width > 0 ? el.width / rect.width : 1;
    const sy = rect.height > 0 ? el.height / rect.height : 1;
    return { x: (event.clientX - rect.left) * sx, y: (event.clientY - rect.top) * sy };
  }

  protected start(event: PointerEvent): void {
    const ctx = this.context();
    if (ctx === null) {
      return;
    }
    this.drawing = true;
    const { x, y } = this.point(event);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  protected move(event: PointerEvent): void {
    const ctx = this.context();
    if (!this.drawing || ctx === null) {
      return;
    }
    const { x, y } = this.point(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    this.hasInk.set(true);
  }

  protected end(): void {
    if (!this.drawing) {
      return;
    }
    this.drawing = false;
    if (this.hasInk()) {
      this.signed.emit(canvasToPng(this.canvas().nativeElement));
    }
  }

  protected clear(): void {
    const el = this.canvas().nativeElement;
    this.context()?.clearRect(0, 0, el.width, el.height);
    this.hasInk.set(false);
    this.signed.emit(null);
  }
}

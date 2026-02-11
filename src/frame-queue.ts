/**
 * Bounded frame queue with backpressure drop policy.
 * Uses a circular buffer for O(1) enqueue/dequeue regardless of queue state.
 *
 * Validates: Requirements 2.3, 12.1, 15.1, 15.2, 15.4
 */

import type { FrameHeader } from "./types.js";

export interface QueuedFrame {
  header: FrameHeader;
  jpegBuffer: Buffer;
  enqueuedAt: number; // Date.now() for staleness detection
}

export class FrameQueue {
  private buffer: (QueuedFrame | null)[];
  private head: number; // index of the oldest element
  private tail: number; // index of the next write position
  private count: number;
  private maxSize: number;
  private droppedByBackpressure: number;

  constructor(maxSize: number = 20) {
    this.maxSize = maxSize;
    this.buffer = new Array<QueuedFrame | null>(maxSize).fill(null);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.droppedByBackpressure = 0;
  }

  /**
   * Enqueue a frame. If queue is full, drop the oldest frame and increment
   * the backpressure counter. O(1) regardless of queue state.
   */
  enqueue(header: FrameHeader, jpegBuffer: Buffer): void {
    const frame: QueuedFrame = {
      header,
      jpegBuffer,
      enqueuedAt: Date.now(),
    };

    if (this.count === this.maxSize) {
      // Queue full — drop oldest (at head), overwrite with new frame
      this.droppedByBackpressure++;
      this.buffer[this.head] = null; // release reference to oldest
      this.head = (this.head + 1) % this.maxSize;
      this.count--;
    }

    this.buffer[this.tail] = frame;
    this.tail = (this.tail + 1) % this.maxSize;
    this.count++;
  }

  /** Dequeue the next frame (FIFO), or null if empty. */
  dequeue(): QueuedFrame | null {
    if (this.count === 0) {
      return null;
    }

    const frame = this.buffer[this.head];
    this.buffer[this.head] = null; // release reference
    this.head = (this.head + 1) % this.maxSize;
    this.count--;
    return frame;
  }

  /** Number of frames dropped due to backpressure (queue full at enqueue time). */
  get framesDroppedByBackpressure(): number {
    return this.droppedByBackpressure;
  }

  /** Current queue depth. */
  get size(): number {
    return this.count;
  }

  /** Clear all queued frames and reset queue pointers. */
  clear(): void {
    for (let i = 0; i < this.maxSize; i++) {
      this.buffer[i] = null;
    }
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

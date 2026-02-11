/**
 * Unit tests for frame-queue.ts
 * Validates: Requirements 2.3, 12.1, 15.1, 15.2, 15.4
 */

import { describe, it, expect } from "vitest";
import { FrameQueue } from "./frame-queue.js";
import type { FrameHeader } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeHeader(seq: number, timestamp?: number): FrameHeader {
  return {
    timestamp: timestamp ?? seq * 0.5,
    seq,
    width: 640,
    height: 480,
  };
}

function makeJpeg(id: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(id, 0);
  return buf;
}

// ─── Basic FIFO Behavior ────────────────────────────────────────────────────────

describe("FrameQueue", () => {
  describe("basic enqueue/dequeue FIFO behavior", () => {
    it("dequeues frames in the order they were enqueued", () => {
      const q = new FrameQueue(5);
      q.enqueue(makeHeader(0), makeJpeg(0));
      q.enqueue(makeHeader(1), makeJpeg(1));
      q.enqueue(makeHeader(2), makeJpeg(2));

      const f0 = q.dequeue();
      const f1 = q.dequeue();
      const f2 = q.dequeue();

      expect(f0?.header.seq).toBe(0);
      expect(f1?.header.seq).toBe(1);
      expect(f2?.header.seq).toBe(2);
    });

    it("preserves header and jpegBuffer data through round-trip", () => {
      const q = new FrameQueue();
      const header = makeHeader(42, 3.14);
      const jpeg = makeJpeg(99);

      q.enqueue(header, jpeg);
      const result = q.dequeue();

      expect(result).not.toBeNull();
      expect(result!.header).toEqual(header);
      expect(result!.jpegBuffer).toEqual(jpeg);
      expect(typeof result!.enqueuedAt).toBe("number");
    });
  });

  // ─── Backpressure: Drops Oldest When Full ───────────────────────────────────

  describe("backpressure: drops oldest when full", () => {
    it("drops the oldest frame when enqueuing into a full queue", () => {
      const q = new FrameQueue(3);
      q.enqueue(makeHeader(0), makeJpeg(0));
      q.enqueue(makeHeader(1), makeJpeg(1));
      q.enqueue(makeHeader(2), makeJpeg(2));
      // Queue is full (size 3). Enqueue a 4th — should drop seq=0.
      q.enqueue(makeHeader(3), makeJpeg(3));

      expect(q.size).toBe(3);
      expect(q.dequeue()?.header.seq).toBe(1);
      expect(q.dequeue()?.header.seq).toBe(2);
      expect(q.dequeue()?.header.seq).toBe(3);
    });

    it("drops multiple oldest frames under sustained overflow", () => {
      const q = new FrameQueue(2);
      q.enqueue(makeHeader(0), makeJpeg(0));
      q.enqueue(makeHeader(1), makeJpeg(1));
      q.enqueue(makeHeader(2), makeJpeg(2)); // drops seq=0
      q.enqueue(makeHeader(3), makeJpeg(3)); // drops seq=1

      expect(q.size).toBe(2);
      expect(q.dequeue()?.header.seq).toBe(2);
      expect(q.dequeue()?.header.seq).toBe(3);
    });
  });

  // ─── framesDroppedByBackpressure Counter ──────────────────────────────────

  describe("framesDroppedByBackpressure counter", () => {
    it("starts at zero", () => {
      const q = new FrameQueue(5);
      expect(q.framesDroppedByBackpressure).toBe(0);
    });

    it("increments once per overflow enqueue", () => {
      const q = new FrameQueue(2);
      q.enqueue(makeHeader(0), makeJpeg(0));
      q.enqueue(makeHeader(1), makeJpeg(1));
      expect(q.framesDroppedByBackpressure).toBe(0);

      q.enqueue(makeHeader(2), makeJpeg(2)); // overflow
      expect(q.framesDroppedByBackpressure).toBe(1);

      q.enqueue(makeHeader(3), makeJpeg(3)); // overflow again
      expect(q.framesDroppedByBackpressure).toBe(2);
    });

    it("counter persists across clear()", () => {
      const q = new FrameQueue(1);
      q.enqueue(makeHeader(0), makeJpeg(0));
      q.enqueue(makeHeader(1), makeJpeg(1)); // overflow
      expect(q.framesDroppedByBackpressure).toBe(1);

      q.clear();
      // Counter is cumulative — clear doesn't reset it
      expect(q.framesDroppedByBackpressure).toBe(1);
    });
  });

  // ─── clear() ──────────────────────────────────────────────────────────────

  describe("clear()", () => {
    it("empties the queue", () => {
      const q = new FrameQueue(5);
      q.enqueue(makeHeader(0), makeJpeg(0));
      q.enqueue(makeHeader(1), makeJpeg(1));
      q.enqueue(makeHeader(2), makeJpeg(2));

      q.clear();

      expect(q.size).toBe(0);
      expect(q.dequeue()).toBeNull();
    });

    it("allows re-use after clear", () => {
      const q = new FrameQueue(3);
      q.enqueue(makeHeader(0), makeJpeg(0));
      q.enqueue(makeHeader(1), makeJpeg(1));
      q.clear();

      q.enqueue(makeHeader(10), makeJpeg(10));
      expect(q.size).toBe(1);
      expect(q.dequeue()?.header.seq).toBe(10);
    });
  });

  // ─── size Getter ──────────────────────────────────────────────────────────

  describe("size getter", () => {
    it("returns 0 for a new queue", () => {
      expect(new FrameQueue().size).toBe(0);
    });

    it("tracks enqueue and dequeue accurately", () => {
      const q = new FrameQueue(10);
      q.enqueue(makeHeader(0), makeJpeg(0));
      expect(q.size).toBe(1);

      q.enqueue(makeHeader(1), makeJpeg(1));
      expect(q.size).toBe(2);

      q.dequeue();
      expect(q.size).toBe(1);

      q.dequeue();
      expect(q.size).toBe(0);
    });

    it("never exceeds maxSize even under overflow", () => {
      const q = new FrameQueue(3);
      for (let i = 0; i < 10; i++) {
        q.enqueue(makeHeader(i), makeJpeg(i));
      }
      expect(q.size).toBe(3);
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("dequeue from empty queue returns null", () => {
      const q = new FrameQueue();
      expect(q.dequeue()).toBeNull();
    });

    it("single-element queue works correctly", () => {
      const q = new FrameQueue(1);
      q.enqueue(makeHeader(0), makeJpeg(0));
      expect(q.size).toBe(1);

      const frame = q.dequeue();
      expect(frame?.header.seq).toBe(0);
      expect(q.size).toBe(0);
      expect(q.dequeue()).toBeNull();
    });

    it("single-element queue overflow replaces the only frame", () => {
      const q = new FrameQueue(1);
      q.enqueue(makeHeader(0), makeJpeg(0));
      q.enqueue(makeHeader(1), makeJpeg(1)); // drops seq=0

      expect(q.size).toBe(1);
      expect(q.framesDroppedByBackpressure).toBe(1);
      expect(q.dequeue()?.header.seq).toBe(1);
    });

    it("default maxSize is 20", () => {
      const q = new FrameQueue();
      for (let i = 0; i < 20; i++) {
        q.enqueue(makeHeader(i), makeJpeg(i));
      }
      expect(q.size).toBe(20);
      expect(q.framesDroppedByBackpressure).toBe(0);

      // 21st frame triggers backpressure
      q.enqueue(makeHeader(20), makeJpeg(20));
      expect(q.size).toBe(20);
      expect(q.framesDroppedByBackpressure).toBe(1);
    });
  });

  // ─── O(1) Enqueue Performance ─────────────────────────────────────────────

  describe("O(1) enqueue performance (circular buffer)", () => {
    it("enqueue time does not degrade under sustained overflow", () => {
      const q = new FrameQueue(10);
      // Fill the queue
      for (let i = 0; i < 10; i++) {
        q.enqueue(makeHeader(i), makeJpeg(i));
      }

      // Measure enqueue time under overflow (1000 overflow enqueues)
      const iterations = 1000;
      const start = performance.now();
      for (let i = 10; i < 10 + iterations; i++) {
        q.enqueue(makeHeader(i), makeJpeg(i));
      }
      const elapsed = performance.now() - start;
      const avgMicroseconds = (elapsed / iterations) * 1000;

      // Each enqueue should be well under 100µs on any reasonable hardware
      // This is a sanity check, not a strict benchmark
      expect(avgMicroseconds).toBeLessThan(100);
      expect(q.size).toBe(10);
      expect(q.framesDroppedByBackpressure).toBe(iterations);
    });

    it("interleaved enqueue/dequeue maintains O(1) behavior", () => {
      const q = new FrameQueue(5);
      const iterations = 1000;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        q.enqueue(makeHeader(i), makeJpeg(i));
        if (i % 2 === 0) {
          q.dequeue();
        }
      }
      const elapsed = performance.now() - start;
      const avgMicroseconds = (elapsed / iterations) * 1000;

      expect(avgMicroseconds).toBeLessThan(100);
    });
  });
});

package com.printflow.scheduler;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;

/**
 * Array-based binary max-heap used for HIGH and URGENT print jobs.
 *
 * For the node at index i:
 *   parent = (i - 1) / 2
 *   left   = 2 * i + 1
 *   right  = 2 * i + 2
 *
 * Jobs are ordered by the key (priority level, -arrival sequence), so the
 * root is always the most urgent job, and the earliest one among equals.
 *
 * Every insert/extract also records a step-by-step trace (place, compare,
 * swap, settle, ...) with a snapshot of the array after each step. The
 * dashboard replays it as an animation. The trace does not affect the heap.
 */
public class MaxHeap {

    private static final int INITIAL_CAPACITY = 8;

    private PrintJob[] items = new PrintJob[INITIAL_CAPACITY];
    private int size;
    private final List<Map<String, Object>> trace = new ArrayList<>();

    /** Append at the bottom and bubble up. O(log n). */
    public void insert(PrintJob job) {
        if (size == items.length) {
            PrintJob[] bigger = new PrintJob[items.length * 2];
            System.arraycopy(items, 0, bigger, 0, size);
            items = bigger;
        }
        items[size] = job;
        size++;
        record("insert", size - 1, -1, size);
        heapifyUp(size - 1);
    }

    /** Remove and return the root, move the last item to the root, sift down. O(log n). */
    public PrintJob extractMax() {
        if (size == 0) {
            throw new NoSuchElementException("extractMax from empty heap");
        }
        PrintJob top = items[0];
        items[0] = null;
        record("remove", 0, -1, size).put("jobId", top.getJobId());   // root slot is now a hole
        size--;
        items[0] = items[size];
        items[size] = null;
        if (size > 0) {
            record("move", size, 0, size);   // last item from index `size` to the root
            heapifyDown(0);
        }
        return top;
    }

    /** Return the highest-priority job without removing it, or null. O(1). */
    public PrintJob peek() {
        return size == 0 ? null : items[0];
    }

    /** Swap the item upward while it outranks its parent. */
    void heapifyUp(int index) {
        while (index > 0) {
            int parent = (index - 1) / 2;
            boolean wins = items[index].outranks(items[parent]);
            record("compare", index, parent, size).put("winner", wins ? index : parent);
            if (wins) {
                swap(index, parent);
                record("swap", index, parent, size);
                index = parent;
            } else {
                break;
            }
        }
        record("settle", index, -1, size);
    }

    /** Swap the item downward while a child outranks it. */
    void heapifyDown(int index) {
        while (true) {
            int largest = index;
            int left = 2 * index + 1;
            int right = 2 * index + 2;
            if (left < size) {
                boolean wins = items[left].outranks(items[largest]);
                record("compare", largest, left, size).put("winner", wins ? left : largest);
                if (wins) {
                    largest = left;
                }
            }
            if (right < size) {
                boolean wins = items[right].outranks(items[largest]);
                record("compare", largest, right, size).put("winner", wins ? right : largest);
                if (wins) {
                    largest = right;
                }
            }
            if (largest == index) {
                break;
            }
            swap(index, largest);
            record("swap", index, largest, size);
            index = largest;
        }
        record("settle", index, -1, size);
    }

    private void swap(int i, int j) {
        PrintJob tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
    }

    public boolean isEmpty() {
        return size == 0;
    }

    public int size() {
        return size;
    }

    /** Jobs in internal array order (index 0 = root), for tree visualisation. */
    public List<PrintJob> toList() {
        List<PrintJob> jobs = new ArrayList<>(size);
        for (int i = 0; i < size; i++) {
            jobs.add(items[i]);
        }
        return jobs;
    }

    // ---- animation trace ------------------------------------------------

    public void clearTrace() {
        trace.clear();
    }

    /** Label the steps that follow, e.g. kind "print" with "Print the next job". */
    public void traceLabel(String kind, String text) {
        Map<String, Object> step = record("phase", -1, -1, size);
        step.put("kind", kind);
        step.put("text", text);
    }

    public List<Map<String, Object>> getTrace() {
        return List.copyOf(trace);
    }

    /** Record one step with the first {@code count} array slots (job IDs, null for a hole). */
    private Map<String, Object> record(String op, int a, int b, int count) {
        List<String> snapshot = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            snapshot.add(items[i] == null ? null : items[i].getJobId());
        }
        Map<String, Object> step = new LinkedHashMap<>();
        step.put("op", op);
        step.put("a", a);
        step.put("b", b);
        step.put("heap", snapshot);
        trace.add(step);
        return step;
    }
}

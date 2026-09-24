package com.printflow.scheduler;

import java.util.ArrayList;
import java.util.List;
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
 */
public class MaxHeap {

    private static final int INITIAL_CAPACITY = 8;

    private PrintJob[] items = new PrintJob[INITIAL_CAPACITY];
    private int size;

    /** Append at the bottom and bubble up. O(log n). */
    public void insert(PrintJob job) {
        if (size == items.length) {
            PrintJob[] bigger = new PrintJob[items.length * 2];
            System.arraycopy(items, 0, bigger, 0, size);
            items = bigger;
        }
        items[size] = job;
        size++;
        heapifyUp(size - 1);
    }

    /** Remove and return the root, move the last item to the root, sift down. O(log n). */
    public PrintJob extractMax() {
        if (size == 0) {
            throw new NoSuchElementException("extractMax from empty heap");
        }
        PrintJob top = items[0];
        size--;
        items[0] = items[size];
        items[size] = null;
        if (size > 0) {
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
            if (items[index].outranks(items[parent])) {
                swap(index, parent);
                index = parent;
            } else {
                break;
            }
        }
    }

    /** Swap the item downward while a child outranks it. */
    void heapifyDown(int index) {
        while (true) {
            int largest = index;
            int left = 2 * index + 1;
            int right = 2 * index + 2;
            if (left < size && items[left].outranks(items[largest])) {
                largest = left;
            }
            if (right < size && items[right].outranks(items[largest])) {
                largest = right;
            }
            if (largest == index) {
                break;
            }
            swap(index, largest);
            index = largest;
        }
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
}

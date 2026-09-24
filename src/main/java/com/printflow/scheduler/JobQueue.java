package com.printflow.scheduler;

import java.util.ArrayList;
import java.util.List;
import java.util.NoSuchElementException;

/**
 * Linked-node FIFO queue used for NORMAL print jobs.
 *
 * FRONT -> [job] -> [job] -> [job] <- REAR
 * enqueue at the rear, dequeue from the front; both are O(1).
 */
public class JobQueue {

    private static class Node {
        final PrintJob job;
        Node next;

        Node(PrintJob job) {
            this.job = job;
        }
    }

    private Node front;
    private Node rear;
    private int size;

    /** Add a job at the rear. O(1). */
    public void enqueue(PrintJob job) {
        Node node = new Node(job);
        if (rear == null) {
            front = rear = node;
        } else {
            rear.next = node;
            rear = node;
        }
        size++;
    }

    /** Remove and return the job at the front. O(1). */
    public PrintJob dequeue() {
        if (front == null) {
            throw new NoSuchElementException("dequeue from empty queue");
        }
        Node node = front;
        front = node.next;
        if (front == null) {
            rear = null;
        }
        size--;
        return node.job;
    }

    /** Return the front job without removing it, or null. O(1). */
    public PrintJob peek() {
        return front == null ? null : front.job;
    }

    public boolean isEmpty() {
        return front == null;
    }

    public int size() {
        return size;
    }

    /** Jobs from FRONT to REAR, for display. O(n). */
    public List<PrintJob> toList() {
        List<PrintJob> jobs = new ArrayList<>(size);
        for (Node node = front; node != null; node = node.next) {
            jobs.add(node.job);
        }
        return jobs;
    }
}

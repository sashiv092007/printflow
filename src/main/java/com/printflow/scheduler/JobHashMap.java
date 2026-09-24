package com.printflow.scheduler;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Separate-chaining hash map from job ID -> PrintJob.
 *
 * Each bucket is a singly linked chain of entries. When the load factor
 * (entries / buckets) passes 0.75 the table doubles and every entry is
 * rehashed, which keeps chains short and put/get at O(1) average time.
 */
public class JobHashMap {

    private static final int INITIAL_CAPACITY = 16;
    private static final double MAX_LOAD_FACTOR = 0.75;

    private static class Entry {
        final String key;
        PrintJob value;
        Entry next;

        Entry(String key, PrintJob value, Entry next) {
            this.key = key;
            this.value = value;
            this.next = next;
        }
    }

    private Entry[] buckets = new Entry[INITIAL_CAPACITY];
    private int size;

    /** Polynomial rolling hash of the string key, reduced to a bucket index. */
    private int indexFor(String key, int capacity) {
        long h = 0;
        for (int i = 0; i < key.length(); i++) {
            h = (h * 31 + key.charAt(i)) % 4294967296L;   // keep within 2^32
        }
        return (int) (h % capacity);
    }

    /** Insert or overwrite. O(1) average. */
    public void put(String key, PrintJob value) {
        int index = indexFor(key, buckets.length);
        for (Entry e = buckets[index]; e != null; e = e.next) {
            if (e.key.equals(key)) {
                e.value = value;
                return;
            }
        }
        buckets[index] = new Entry(key, value, buckets[index]);
        size++;
        if ((double) size / buckets.length > MAX_LOAD_FACTOR) {
            resize(buckets.length * 2);
        }
    }

    /** Look up a key, or null if absent. O(1) average. */
    public PrintJob get(String key) {
        for (Entry e = buckets[indexFor(key, buckets.length)]; e != null; e = e.next) {
            if (e.key.equals(key)) {
                return e.value;
            }
        }
        return null;
    }

    public boolean containsKey(String key) {
        return get(key) != null;
    }

    public int size() {
        return size;
    }

    public int capacity() {
        return buckets.length;
    }

    public List<PrintJob> values() {
        List<PrintJob> jobs = new ArrayList<>(size);
        for (Entry head : buckets) {
            for (Entry e = head; e != null; e = e.next) {
                jobs.add(e.value);
            }
        }
        return jobs;
    }

    private void resize(int newCapacity) {
        Entry[] newBuckets = new Entry[newCapacity];
        for (Entry head : buckets) {
            Entry e = head;
            while (e != null) {
                Entry next = e.next;
                int index = indexFor(e.key, newCapacity);
                e.next = newBuckets[index];
                newBuckets[index] = e;
                e = next;
            }
        }
        buckets = newBuckets;
    }

    /** Non-empty buckets and the keys chained in each, for visualisation. */
    public List<Map<String, Object>> bucketView() {
        List<Map<String, Object>> view = new ArrayList<>();
        for (int i = 0; i < buckets.length; i++) {
            if (buckets[i] == null) {
                continue;
            }
            List<String> keys = new ArrayList<>();
            for (Entry e = buckets[i]; e != null; e = e.next) {
                keys.add(e.key);
            }
            Map<String, Object> bucket = new LinkedHashMap<>();
            bucket.put("index", i);
            bucket.put("keys", keys);
            view.add(bucket);
        }
        return view;
    }
}

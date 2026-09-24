package com.printflow.scheduler;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.springframework.stereotype.Service;

/**
 * Ties the FIFO queue, max-heap and hash map together.
 *
 * Scheduling rule: URGENT, then HIGH, then NORMAL; the earlier arrival wins
 * when priorities are equal. HIGH/URGENT jobs live in the max-heap and NORMAL
 * jobs in the FIFO queue, so the heap is always checked first.
 *
 * Cancellation uses lazy deletion: only the hash-map entry's status changes.
 * The job stays in the queue/heap and is discarded when it reaches the front
 * or the heap top.
 *
 * Public methods are synchronized because Spring serves requests on multiple threads.
 */
@Service
public class PrintScheduler {

    public static final int FIRST_JOB_NUMBER = 1001;

    /** Result of completing a job: the finished job and the one that started next (or null). */
    public record Completion(PrintJob completed, PrintJob next) {}

    private JobQueue normalQueue;
    private MaxHeap priorityHeap;
    private JobHashMap jobsById;
    private PrintJob currentJob;
    private List<PrintJob> completed;
    private List<PrintJob> cancelled;
    private List<String> lastSkipped;   // IDs discarded by lazy deletion on the last selection
    private int turn;                   // increments each time a job starts printing
    private int nextNumber;
    private int sequence;

    public PrintScheduler() {
        reset();
    }

    public synchronized void reset() {
        normalQueue = new JobQueue();
        priorityHeap = new MaxHeap();
        jobsById = new JobHashMap();
        currentJob = null;
        completed = new ArrayList<>();
        cancelled = new ArrayList<>();
        lastSkipped = new ArrayList<>();
        turn = 0;
        nextNumber = FIRST_JOB_NUMBER;
        sequence = 0;
    }

    // ---- submit -------------------------------------------------------

    public PrintJob submitJob(String user, String document, int pages, String priority) {
        return submitJob(user, document, String.valueOf(pages), priority);
    }

    /**
     * Validate, create a PrintJob, register it in the hash map and place it
     * in the queue (O(1)) or the heap (O(log n)).
     */
    public synchronized PrintJob submitJob(String user, String document, String pages, String priority) {
        user = user == null ? "" : user.strip();
        document = document == null ? "" : document.strip();
        String priorityName = priority == null ? "" : priority.strip().toUpperCase(Locale.ROOT);

        if (user.isEmpty()) {
            throw new SchedulerException("User name is required.");
        }
        if (document.isEmpty()) {
            throw new SchedulerException("Document name is required.");
        }
        int pageCount;
        try {
            pageCount = Integer.parseInt(pages == null ? "" : pages.strip());
        } catch (NumberFormatException e) {
            throw new SchedulerException("Pages must be a whole number.");
        }
        if (pageCount <= 0) {
            throw new SchedulerException("Pages must be greater than zero.");
        }
        Priority level;
        try {
            level = Priority.valueOf(priorityName);
        } catch (IllegalArgumentException e) {
            throw new SchedulerException("Priority must be NORMAL, HIGH or URGENT.");
        }

        String jobId = "PF-" + nextNumber++;
        sequence++;
        PrintJob job = new PrintJob(jobId, user, document, pageCount, level, sequence, turn);

        jobsById.put(jobId, job);
        if (level == Priority.NORMAL) {
            normalQueue.enqueue(job);
        } else {
            priorityHeap.insert(job);
        }
        return job;
    }

    // ---- lookup / cancel ----------------------------------------------

    /** O(1) average lookup through the hash map. */
    public synchronized PrintJob getJob(String jobId) {
        String key = jobId == null ? "" : jobId.strip().toUpperCase(Locale.ROOT);
        PrintJob job = jobsById.get(key);
        if (job == null) {
            throw new SchedulerException("Job ID not found.", 404);
        }
        return job;
    }

    /** Lazy deletion: mark CANCELLED in the hash map; do not touch the queue/heap. */
    public synchronized PrintJob cancelJob(String jobId) {
        PrintJob job = getJob(jobId);
        switch (job.getStatus()) {
            case PRINTING -> throw new SchedulerException("Current job cannot be cancelled.", 409);
            case COMPLETED -> throw new SchedulerException("Completed job cannot be cancelled.", 409);
            case CANCELLED -> throw new SchedulerException("Job is already cancelled.", 409);
            case WAITING -> { }
        }
        job.setStatus(JobStatus.CANCELLED);
        job.setFinishedTurn(turn);
        cancelled.add(job);
        return job;
    }

    // ---- selecting and printing ---------------------------------------

    /**
     * Discard cancelled jobs sitting at the heap top / queue front, then
     * return (without removing) the job that should print next, or null.
     */
    public synchronized PrintJob getNextValidJob() {
        while (!priorityHeap.isEmpty() && priorityHeap.peek().getStatus() == JobStatus.CANCELLED) {
            lastSkipped.add(priorityHeap.extractMax().getJobId());
        }
        while (!normalQueue.isEmpty() && normalQueue.peek().getStatus() == JobStatus.CANCELLED) {
            lastSkipped.add(normalQueue.dequeue().getJobId());
        }
        if (!priorityHeap.isEmpty()) {
            return priorityHeap.peek();
        }
        return normalQueue.peek();
    }

    /** Send the next valid job to the idle printer. */
    public synchronized PrintJob startNextJob() {
        if (currentJob != null) {
            throw new SchedulerException("Printer is busy. Complete the current job first.", 409);
        }
        lastSkipped = new ArrayList<>();
        PrintJob job = takeNextValidJob();
        if (job == null) {
            throw new SchedulerException("No waiting jobs.", 409);
        }
        return job;
    }

    /** Finish the printing job, then automatically start the next one. */
    public synchronized Completion completeCurrentJob() {
        PrintJob job = currentJob;
        if (job == null) {
            throw new SchedulerException("No job is currently printing.", 409);
        }
        job.setStatus(JobStatus.COMPLETED);
        job.setFinishedTurn(turn);
        completed.add(job);
        currentJob = null;

        lastSkipped = new ArrayList<>();
        return new Completion(job, takeNextValidJob());
    }

    private PrintJob takeNextValidJob() {
        PrintJob job = getNextValidJob();
        if (job == null) {
            return null;
        }
        // The heap only holds HIGH/URGENT jobs, so if it is non-empty its top was chosen.
        if (!priorityHeap.isEmpty()) {
            priorityHeap.extractMax();
        } else {
            normalQueue.dequeue();
        }
        turn++;
        job.setStatus(JobStatus.PRINTING);
        job.setStartedTurn(turn);
        currentJob = job;
        return job;
    }

    // ---- accessors ----------------------------------------------------

    public synchronized PrintJob getCurrentJob() { return currentJob; }
    public synchronized List<String> getLastSkipped() { return List.copyOf(lastSkipped); }
    public synchronized int getTurn() { return turn; }
    public synchronized int getHashMapCapacity() { return jobsById.capacity(); }
    public synchronized int getJobCount() { return jobsById.size(); }

    // ---- serialisation ------------------------------------------------

    /** Everything the dashboard needs; Spring turns this into JSON. */
    public synchronized Map<String, Object> getState() {
        int waiting = 0;
        for (PrintJob job : jobsById.values()) {
            if (job.getStatus() == JobStatus.WAITING) {
                waiting++;
            }
        }
        int pagesPrinted = 0;
        for (PrintJob job : completed) {
            pagesPrinted += job.getPages();
        }

        Map<String, Object> hashMap = new LinkedHashMap<>();
        hashMap.put("size", jobsById.size());
        hashMap.put("capacity", jobsById.capacity());
        hashMap.put("buckets", jobsById.bucketView());

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("totalJobs", jobsById.size());
        stats.put("waiting", waiting);
        stats.put("printing", currentJob == null ? 0 : 1);
        stats.put("completed", completed.size());
        stats.put("cancelled", cancelled.size());
        stats.put("pagesPrinted", pagesPrinted);

        Map<String, Object> state = new LinkedHashMap<>();
        state.put("currentJob", currentJob);
        state.put("priorityHeap", priorityHeap.toList());
        state.put("normalQueue", normalQueue.toList());
        state.put("completed", List.copyOf(completed));
        state.put("cancelled", List.copyOf(cancelled));
        state.put("lastSkipped", List.copyOf(lastSkipped));
        state.put("turn", turn);
        state.put("hashMap", hashMap);
        state.put("stats", stats);
        return state;
    }

    /**
     * The internal layout of each data structure, for the DSA visualiser:
     * queue from FRONT to REAR, heap as its array with parent/child indices,
     * and the hash map's bucket chains.
     */
    public synchronized Map<String, Object> getStructures() {
        List<Map<String, Object>> queueNodes = new ArrayList<>();
        for (PrintJob job : normalQueue.toList()) {
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("jobId", job.getJobId());
            node.put("status", job.getStatus());
            queueNodes.add(node);
        }
        Map<String, Object> queue = new LinkedHashMap<>();
        queue.put("front", queueNodes.isEmpty() ? null : queueNodes.get(0).get("jobId"));
        queue.put("rear", queueNodes.isEmpty() ? null : queueNodes.get(queueNodes.size() - 1).get("jobId"));
        queue.put("size", normalQueue.size());
        queue.put("nodes", queueNodes);

        List<PrintJob> heapJobs = priorityHeap.toList();
        int n = heapJobs.size();
        List<Map<String, Object>> heapNodes = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            PrintJob job = heapJobs.get(i);
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("index", i);
            node.put("jobId", job.getJobId());
            node.put("priority", job.getPriority());
            node.put("status", job.getStatus());
            node.put("key", job.getKey());
            node.put("parent", i == 0 ? null : (i - 1) / 2);
            node.put("left", 2 * i + 1 < n ? 2 * i + 1 : null);
            node.put("right", 2 * i + 2 < n ? 2 * i + 2 : null);
            heapNodes.add(node);
        }
        Map<String, Object> heap = new LinkedHashMap<>();
        heap.put("size", n);
        heap.put("nodes", heapNodes);

        Map<String, Object> hashMap = new LinkedHashMap<>();
        hashMap.put("size", jobsById.size());
        hashMap.put("capacity", jobsById.capacity());
        hashMap.put("loadFactor", (double) jobsById.size() / jobsById.capacity());
        hashMap.put("buckets", jobsById.bucketView());

        Map<String, Object> structures = new LinkedHashMap<>();
        structures.put("normalQueue", queue);
        structures.put("priorityHeap", heap);
        structures.put("hashMap", hashMap);
        structures.put("complexities", List.of(
                complexity("Submit normal job", "O(1)", "Enqueue at the rear of the linked queue"),
                complexity("Submit urgent/high job", "O(log n)", "Heap insert + heapifyUp"),
                complexity("Search job by ID", "O(1) average", "Hash map lookup"),
                complexity("Cancel job", "O(1) average", "Hash map lookup + status change (lazy deletion)"),
                complexity("Print next urgent/high job", "O(log n)", "extractMax + heapifyDown"),
                complexity("Print next normal job", "O(1)", "Dequeue from the front")));
        return structures;
    }

    private static Map<String, String> complexity(String operation, String time, String how) {
        Map<String, String> row = new LinkedHashMap<>();
        row.put("operation", operation);
        row.put("time", time);
        row.put("how", how);
        return row;
    }
}

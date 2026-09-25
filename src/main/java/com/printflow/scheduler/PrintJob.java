package com.printflow.scheduler;

/** One print request plus the metadata the scheduler needs. */
public class PrintJob {

    private final String jobId;
    private final String user;
    private final String document;
    private final int pages;
    private final Priority priority;
    private final int sequence;        // global arrival order, used to break ties
    private final int submittedTurn;   // simulation turn when submitted
    private JobStatus status = JobStatus.WAITING;
    private Integer startedTurn;
    private Integer finishedTurn;
    private Integer agedTurn;          // turn when fairness aging promoted it, or null

    public PrintJob(String jobId, String user, String document, int pages,
                    Priority priority, int sequence, int submittedTurn) {
        this.jobId = jobId;
        this.user = user;
        this.document = document;
        this.pages = pages;
        this.priority = priority;
        this.sequence = sequence;
        this.submittedTurn = submittedTurn;
    }

    /**
     * Heap ordering: higher priority wins, then the earlier arrival wins.
     * Equivalent to comparing the key (level, -sequence).
     */
    public boolean outranks(PrintJob other) {
        if (getLevel() != other.getLevel()) {
            return getLevel() > other.getLevel();
        }
        return sequence < other.sequence;
    }

    /**
     * Fairness aging: a NORMAL job that has waited too long is treated as HIGH.
     * Its original priority is kept for display; only the heap level changes.
     */
    void promote(int turn) {
        this.agedTurn = turn;
    }

    public boolean isAged() { return agedTurn != null; }
    public Integer getAgedTurn() { return agedTurn; }

    /** The priority the heap actually uses (HIGH for an aged NORMAL job). */
    public Priority getEffectivePriority() {
        return isAged() ? Priority.HIGH : priority;
    }

    /** The comparison key (level, -sequence), exposed for the visualiser. */
    public int[] getKey() {
        return new int[] {getLevel(), -sequence};
    }

    public String getJobId() { return jobId; }
    public String getUser() { return user; }
    public String getDocument() { return document; }
    public int getPages() { return pages; }
    public Priority getPriority() { return priority; }
    public int getLevel() { return getEffectivePriority().getLevel(); }
    public int getSequence() { return sequence; }
    public int getSubmittedTurn() { return submittedTurn; }
    public JobStatus getStatus() { return status; }
    public Integer getStartedTurn() { return startedTurn; }
    public Integer getFinishedTurn() { return finishedTurn; }

    void setStatus(JobStatus status) { this.status = status; }
    void setStartedTurn(Integer turn) { this.startedTurn = turn; }
    void setFinishedTurn(Integer turn) { this.finishedTurn = turn; }

    @Override
    public String toString() {
        return "PrintJob(" + jobId + ", " + priority + ", " + status + ")";
    }
}

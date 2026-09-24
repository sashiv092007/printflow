package com.printflow.scheduler;

/** Print priority. The numeric level is what the max-heap compares. */
public enum Priority {
    NORMAL(1),
    HIGH(2),
    URGENT(3);

    private final int level;

    Priority(int level) {
        this.level = level;
    }

    public int getLevel() {
        return level;
    }
}

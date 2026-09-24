package com.printflow.scheduler;

/** A rejected action. statusCode is the HTTP status the REST layer should return. */
public class SchedulerException extends RuntimeException {

    private final int statusCode;

    public SchedulerException(String message) {
        this(message, 400);
    }

    public SchedulerException(String message, int statusCode) {
        super(message);
        this.statusCode = statusCode;
    }

    public int getStatusCode() {
        return statusCode;
    }
}

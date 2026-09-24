package com.printflow.api;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import com.printflow.scheduler.SchedulerException;

/** Turns errors into JSON like {"error": "Job ID not found."} with a matching HTTP status. */
@RestControllerAdvice
public class ApiErrorHandler {

    @ExceptionHandler(SchedulerException.class)
    public ResponseEntity<Map<String, String>> handleScheduler(SchedulerException e) {
        return ResponseEntity.status(e.getStatusCode()).body(Map.of("error", e.getMessage()));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, String>> handleBadJson(HttpMessageNotReadableException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(Map.of("error", "Request body must be valid JSON."));
    }
}

package com.printflow.api;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.printflow.scheduler.PrintJob;
import com.printflow.scheduler.PrintScheduler;

/**
 * REST endpoints for PrintFlow. The controller only translates HTTP to
 * scheduler calls; all DSA logic lives in com.printflow.scheduler.
 *
 * Every action returns the full dashboard "state" so the frontend can
 * simply redraw after each call.
 */
@RestController
@RequestMapping("/api")
public class PrintFlowController {

    private final PrintScheduler scheduler;

    public PrintFlowController(PrintScheduler scheduler) {
        this.scheduler = scheduler;
    }

    /** Body: {"user": "...", "document": "...", "pages": 5, "priority": "NORMAL|HIGH|URGENT"} */
    @PostMapping("/jobs")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> submitJob(@RequestBody Map<String, Object> body) {
        PrintJob job = scheduler.submitJob(
                text(body.get("user")),
                text(body.get("document")),
                text(body.get("pages")),
                text(body.get("priority")));
        return response("Job " + job.getJobId() + " submitted.", "job", job);
    }

    @GetMapping("/state")
    public Map<String, Object> getState() {
        return scheduler.getState();
    }

    @GetMapping("/jobs/{jobId}")
    public PrintJob getJob(@PathVariable String jobId) {
        return scheduler.getJob(jobId);
    }

    @PutMapping("/jobs/{jobId}/cancel")
    public Map<String, Object> cancelJob(@PathVariable String jobId) {
        PrintJob job = scheduler.cancelJob(jobId);
        return response("Job " + job.getJobId() + " cancelled.", "job", job);
    }

    @PostMapping("/printer/start-next")
    public Map<String, Object> startNext() {
        PrintJob job = scheduler.startNextJob();
        return response("Now printing " + job.getJobId() + ".", "job", job);
    }

    @PostMapping("/printer/complete")
    public Map<String, Object> complete() {
        PrintScheduler.Completion result = scheduler.completeCurrentJob();
        String message = "Completed " + result.completed().getJobId() + ". "
                + (result.next() == null
                        ? "No waiting jobs."
                        : "Now printing " + result.next().getJobId() + ".");
        Map<String, Object> body = response(message, "completed", result.completed());
        body.put("next", result.next());
        return body;
    }

    @GetMapping("/structures")
    public Map<String, Object> getStructures() {
        return scheduler.getStructures();
    }

    @PostMapping("/reset")
    public Map<String, Object> reset() {
        scheduler.reset();
        return response("Demo data reset.", null, null);
    }

    private Map<String, Object> response(String message, String key, Object value) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("message", message);
        if (key != null) {
            body.put(key, value);
        }
        body.put("skipped", scheduler.getLastSkipped());
        body.put("state", scheduler.getState());
        return body;
    }

    private static String text(Object value) {
        return value == null ? null : String.valueOf(value);
    }
}

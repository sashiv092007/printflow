package com.printflow.scheduler;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;

class PrintSchedulerTest {

    private final PrintScheduler s = new PrintScheduler();

    private static void expectError(Executable action, String message) {
        SchedulerException e = assertThrows(SchedulerException.class, action);
        assertEquals(message, e.getMessage());
    }

    @SuppressWarnings("unchecked")
    private List<String> idsIn(String stateKey) {
        List<PrintJob> jobs = (List<PrintJob>) s.getState().get(stateKey);
        return jobs.stream().map(PrintJob::getJobId).toList();
    }

    @Test
    void evaluationDemo() {
        s.submitJob("Shiv", "Lab_Record.pdf", 15, "NORMAL");    // PF-1001
        s.submitJob("Asha", "Assignment.pdf", 6, "NORMAL");     // PF-1002
        s.submitJob("Ravi", "Notes.pdf", 3, "NORMAL");          // PF-1003
        s.submitJob("Admin", "Exam_Papers.pdf", 4, "URGENT");   // PF-1004

        // Urgent job prints before the earlier normal jobs.
        assertEquals("PF-1004", s.startNextJob().getJobId());

        // Cancel PF-1002: status changes in the hash map, but it stays in the queue.
        assertEquals(JobStatus.WAITING, s.getJob("PF-1002").getStatus());
        s.cancelJob("pf-1002");                                  // IDs are case-insensitive
        assertEquals(JobStatus.CANCELLED, s.getJob("PF-1002").getStatus());
        assertEquals(List.of("PF-1001", "PF-1002", "PF-1003"), idsIn("normalQueue"));

        assertEquals("PF-1001", s.completeCurrentJob().next().getJobId());
        assertEquals("PF-1003", s.completeCurrentJob().next().getJobId(), "PF-1002 should be skipped");
        assertEquals(List.of("PF-1002"), s.getLastSkipped());

        PrintScheduler.Completion last = s.completeCurrentJob();
        assertEquals("PF-1003", last.completed().getJobId());
        assertNull(last.next());

        assertEquals(List.of("PF-1004", "PF-1001", "PF-1003"), idsIn("completed"));
        assertEquals(List.of("PF-1002"), idsIn("cancelled"));
        assertTrue(idsIn("normalQueue").isEmpty());
        assertNull(s.getCurrentJob());
        Map<?, ?> stats = (Map<?, ?>) s.getState().get("stats");
        assertEquals(4 + 15 + 3, stats.get("pagesPrinted"));
    }

    @Test
    void priorityOrderAndTieBreaking() {
        String[] plan = {"NORMAL", "HIGH", "URGENT", "NORMAL", "HIGH", "URGENT",
                         "HIGH", "NORMAL", "URGENT", "HIGH", "NORMAL", "URGENT"};
        for (int i = 0; i < plan.length; i++) {
            s.submitJob("user" + i, "doc" + i + ".pdf", i + 1, plan[i]);
        }

        List<String> expected = IntStream.range(0, plan.length).boxed()
                .sorted(Comparator.<Integer>comparingInt(i -> -Priority.valueOf(plan[i]).getLevel())
                        .thenComparingInt(i -> i))
                .map(i -> "PF-" + (1001 + i))
                .toList();

        List<String> printed = new ArrayList<>();
        printed.add(s.startNextJob().getJobId());
        PrintJob next;
        while ((next = s.completeCurrentJob().next()) != null) {
            printed.add(next.getJobId());
        }
        assertEquals(expected, printed);
    }

    @Test
    void cancelledJobInHeapIsSkipped() {
        s.submitJob("a", "a.pdf", 1, "URGENT");   // PF-1001
        s.submitJob("b", "b.pdf", 1, "HIGH");     // PF-1002
        s.submitJob("c", "c.pdf", 1, "NORMAL");   // PF-1003
        s.cancelJob("PF-1001");
        assertEquals("PF-1002", s.startNextJob().getJobId());
        assertEquals(List.of("PF-1001"), s.getLastSkipped());
    }

    @Test
    void validationAndErrors() {
        expectError(() -> s.submitJob("", "x.pdf", 1, "NORMAL"), "User name is required.");
        expectError(() -> s.submitJob("a", " ", 1, "NORMAL"), "Document name is required.");
        expectError(() -> s.submitJob("a", "x.pdf", 0, "NORMAL"), "Pages must be greater than zero.");
        expectError(() -> s.submitJob("a", "x.pdf", "abc", "NORMAL"), "Pages must be a whole number.");
        expectError(() -> s.submitJob("a", "x.pdf", 1, "LOW"), "Priority must be NORMAL, HIGH or URGENT.");
        expectError(() -> s.getJob("PF-9999"), "Job ID not found.");
        expectError(s::startNextJob, "No waiting jobs.");
        expectError(s::completeCurrentJob, "No job is currently printing.");

        s.submitJob("a", "x.pdf", "2", "normal");   // string pages and lowercase priority are accepted
        s.submitJob("b", "y.pdf", 1, "NORMAL");
        s.startNextJob();
        expectError(s::startNextJob, "Printer is busy. Complete the current job first.");
        expectError(() -> s.cancelJob("PF-1001"), "Current job cannot be cancelled.");
        s.cancelJob("PF-1002");
        expectError(() -> s.cancelJob("PF-1002"), "Job is already cancelled.");
        s.completeCurrentJob();
        expectError(() -> s.cancelJob("PF-1001"), "Completed job cannot be cancelled.");
        // Only a cancelled job was left, so lazy deletion empties the queue.
        expectError(s::startNextJob, "No waiting jobs.");
    }

    @Test
    void errorsCarryHttpStatusCodes() {
        assertEquals(404, assertThrows(SchedulerException.class, () -> s.getJob("PF-1")).getStatusCode());
        assertEquals(400, assertThrows(SchedulerException.class,
                () -> s.submitJob("a", "x.pdf", -1, "NORMAL")).getStatusCode());
        assertEquals(409, assertThrows(SchedulerException.class, s::startNextJob).getStatusCode());
    }

    @Test
    void hashMapResizes() {
        for (int i = 0; i < 40; i++) {
            s.submitJob("u", "d" + i + ".pdf", 1, "NORMAL");
        }
        assertTrue(s.getHashMapCapacity() > 16);
        assertEquals(40, s.getJobCount());
        for (int i = 0; i < 40; i++) {
            assertEquals("d" + i + ".pdf", s.getJob("PF-" + (1001 + i)).getDocument());
        }
    }

    @Test
    void resetClearsEverything() {
        s.submitJob("a", "a.pdf", 1, "URGENT");
        s.startNextJob();
        s.reset();
        assertNull(s.getCurrentJob());
        assertEquals(0, s.getJobCount());
        assertEquals("PF-1001", s.submitJob("a", "a.pdf", 1, "NORMAL").getJobId());
    }
}

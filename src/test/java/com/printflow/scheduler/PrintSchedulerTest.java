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
        s.setAgingEnabled(false);   // pure priority order; aging is tested separately
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
    void agingPromotesAStarvedNormalJob() {
        s.submitJob("n", "normal.pdf", 1, "NORMAL");         // PF-1001
        for (int i = 0; i < 5; i++) {
            s.submitJob("h", "high" + i + ".pdf", 1, "HIGH"); // PF-1002 .. PF-1006
        }
        List<String> printed = new ArrayList<>();
        printed.add(s.startNextJob().getJobId());
        PrintJob next;
        while ((next = s.completeCurrentJob().next()) != null) {
            printed.add(next.getJobId());
            if (next.getJobId().equals("PF-1001")) {
                assertEquals(List.of("PF-1001"), s.getLastPromoted());
            }
        }
        // Passed over AGING_TURNS = 3 times, then it outranks the later HIGH jobs.
        assertEquals(List.of("PF-1002", "PF-1003", "PF-1004", "PF-1001", "PF-1005", "PF-1006"), printed);
        PrintJob aged = s.getJob("PF-1001");
        assertTrue(aged.isAged());
        assertEquals(Priority.NORMAL, aged.getPriority());
        assertEquals(Priority.HIGH, aged.getEffectivePriority());
    }

    @Test
    void withoutAgingTheNormalJobWaitsForTheWholeHeap() {
        s.setAgingEnabled(false);
        s.submitJob("n", "normal.pdf", 1, "NORMAL");
        for (int i = 0; i < 5; i++) {
            s.submitJob("h", "high" + i + ".pdf", 1, "HIGH");
        }
        String last = s.startNextJob().getJobId();
        PrintJob next;
        while ((next = s.completeCurrentJob().next()) != null) {
            last = next.getJobId();
        }
        assertEquals("PF-1001", last);
    }

    @Test
    void heapTraceRecordsEachStep() {
        s.submitJob("a", "a.pdf", 1, "HIGH");     // PF-1001
        s.submitJob("b", "b.pdf", 1, "HIGH");     // PF-1002
        s.submitJob("c", "c.pdf", 1, "URGENT");   // PF-1003 bubbles from [2] to the root

        List<Map<String, Object>> trace = s.getHeapTrace();
        List<String> ops = trace.stream().map(step -> (String) step.get("op")).toList();
        assertEquals(List.of("phase", "insert", "compare", "swap", "settle"), ops);
        assertEquals(List.of("PF-1003", "PF-1002", "PF-1001"), trace.get(trace.size() - 1).get("heap"));

        s.startNextJob();
        trace = s.getHeapTrace();
        assertEquals("remove", trace.get(1).get("op"));
        assertEquals("PF-1003", trace.get(1).get("jobId"));
        assertEquals("move", trace.get(2).get("op"));
        assertEquals(List.of("PF-1001", "PF-1002"), trace.get(trace.size() - 1).get("heap"));

        s.cancelJob("PF-1002");
        assertTrue(s.getHeapTrace().isEmpty());
    }

    @Test
    void hashCollisionsAndResize() {
        for (int i = 0; i < 12; i++) {
            s.submitJob("u", "d" + i + ".pdf", 1, "NORMAL");
        }
        // PF-1012 lands in the same bucket as PF-1001 and is chained in front of it.
        Map<String, Object> lookup = s.describeLookup("PF-1001");
        assertEquals(7, lookup.get("bucket"));
        assertEquals(List.of("PF-1012", "PF-1001"), lookup.get("chain"));
        assertEquals(2, lookup.get("comparisons"));
        assertEquals(16, s.getHashMapCapacity());

        s.submitJob("u", "d12.pdf", 1, "NORMAL");   // 13 / 16 > 0.75
        assertEquals(32, s.getHashMapCapacity());
        @SuppressWarnings("unchecked")
        List<Map<String, Integer>> resizes =
                (List<Map<String, Integer>>) ((Map<?, ?>) s.getState().get("hashMap")).get("resizes");
        assertEquals(List.of(Map.of("from", 16, "to", 32, "entries", 13)), resizes);

        Map<String, Object> missing = s.describeLookup("pf-9999");
        assertEquals(false, missing.get("found"));
        assertEquals("PF-9999", missing.get("key"));
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

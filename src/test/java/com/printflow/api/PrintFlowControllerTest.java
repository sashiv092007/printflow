package com.printflow.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

@SpringBootTest
class PrintFlowControllerTest {

    @Autowired
    private WebApplicationContext context;

    private MockMvc mvc;

    @BeforeEach
    void setUp() throws Exception {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
        mvc.perform(post("/api/reset")).andExpect(status().isOk());
    }

    private ResultActions submit(String user, String document, Object pages, String priority) throws Exception {
        String pagesJson = pages instanceof String ? "\"" + pages + "\"" : String.valueOf(pages);
        String json = """
                {"user": "%s", "document": "%s", "pages": %s, "priority": "%s"}
                """.formatted(user, document, pagesJson, priority);
        return mvc.perform(post("/api/jobs").contentType(MediaType.APPLICATION_JSON).content(json));
    }

    @Test
    void evaluationDemoOverHttp() throws Exception {
        submit("Shiv", "Lab_Record.pdf", 15, "NORMAL")
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.job.jobId").value("PF-1001"))
                .andExpect(jsonPath("$.job.status").value("WAITING"));
        submit("Asha", "Assignment.pdf", 6, "NORMAL");
        submit("Ravi", "Notes.pdf", 3, "NORMAL");
        submit("Admin", "Exam_Papers.pdf", 4, "urgent")
                .andExpect(jsonPath("$.state.priorityHeap[0].jobId").value("PF-1004"));

        mvc.perform(post("/api/printer/start-next"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.job.jobId").value("PF-1004"))
                .andExpect(jsonPath("$.state.currentJob.jobId").value("PF-1004"));

        mvc.perform(get("/api/jobs/PF-1002"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.document").value("Assignment.pdf"))
                .andExpect(jsonPath("$.status").value("WAITING"));

        mvc.perform(put("/api/jobs/PF-1002/cancel"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.job.status").value("CANCELLED"))
                // Lazy deletion: still physically in the queue.
                .andExpect(jsonPath("$.state.normalQueue[1].jobId").value("PF-1002"))
                .andExpect(jsonPath("$.state.normalQueue[1].status").value("CANCELLED"));

        mvc.perform(post("/api/printer/complete"))
                .andExpect(jsonPath("$.completed.jobId").value("PF-1004"))
                .andExpect(jsonPath("$.next.jobId").value("PF-1001"));
        mvc.perform(post("/api/printer/complete"))
                .andExpect(jsonPath("$.completed.jobId").value("PF-1001"))
                .andExpect(jsonPath("$.next.jobId").value("PF-1003"))
                .andExpect(jsonPath("$.skipped[0]").value("PF-1002"));
        mvc.perform(post("/api/printer/complete"))
                .andExpect(jsonPath("$.next").doesNotExist())
                .andExpect(jsonPath("$.message").value("Completed PF-1003. No waiting jobs."));

        mvc.perform(get("/api/state"))
                .andExpect(jsonPath("$.stats.completed").value(3))
                .andExpect(jsonPath("$.stats.cancelled").value(1))
                .andExpect(jsonPath("$.currentJob").doesNotExist());
    }

    @Test
    void structuresEndpoint() throws Exception {
        submit("a", "a.pdf", 1, "HIGH");
        submit("b", "b.pdf", 1, "URGENT");
        submit("c", "c.pdf", 1, "NORMAL");
        mvc.perform(get("/api/structures"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.priorityHeap.nodes[0].jobId").value("PF-1002"))
                .andExpect(jsonPath("$.priorityHeap.nodes[0].left").value(1))
                .andExpect(jsonPath("$.priorityHeap.nodes[1].parent").value(0))
                .andExpect(jsonPath("$.normalQueue.front").value("PF-1003"))
                .andExpect(jsonPath("$.hashMap.size").value(3))
                .andExpect(jsonPath("$.complexities.length()").value(7));
    }

    @Test
    void heapTraceHashLookupAndAgingSetting() throws Exception {
        submit("a", "a.pdf", 1, "HIGH");
        submit("b", "b.pdf", 1, "URGENT")
                .andExpect(jsonPath("$.heapTrace[0].op").value("phase"))
                .andExpect(jsonPath("$.heapTrace[1].op").value("insert"));

        mvc.perform(get("/api/hash/pf-1001"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.key").value("PF-1001"))
                .andExpect(jsonPath("$.bucket").value(7))
                .andExpect(jsonPath("$.found").value(true))
                .andExpect(jsonPath("$.comparisons").value(1));

        mvc.perform(put("/api/settings/aging").contentType(MediaType.APPLICATION_JSON).content("{\"enabled\": false}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state.aging.enabled").value(false));
        mvc.perform(put("/api/settings/aging").contentType(MediaType.APPLICATION_JSON).content("{\"enabled\": true}"))
                .andExpect(jsonPath("$.state.aging.enabled").value(true))
                .andExpect(jsonPath("$.state.aging.turns").value(3));
    }

    @Test
    void errorsAreJson() throws Exception {
        submit("a", "x.pdf", 0, "NORMAL")
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("Pages must be greater than zero."));
        submit("a", "x.pdf", "abc", "NORMAL")
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("Pages must be a whole number."));
        mvc.perform(post("/api/jobs").contentType(MediaType.APPLICATION_JSON).content("{not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("Request body must be valid JSON."));
        mvc.perform(get("/api/jobs/PF-9999"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("Job ID not found."));
        mvc.perform(post("/api/printer/start-next"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("No waiting jobs."));
        mvc.perform(post("/api/printer/complete"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("No job is currently printing."));

        submit("a", "x.pdf", 1, "NORMAL");
        mvc.perform(post("/api/printer/start-next"));
        mvc.perform(put("/api/jobs/PF-1001/cancel"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("Current job cannot be cancelled."));
    }
}

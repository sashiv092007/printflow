# PrintFlow

**Fair Priority-Based Print Job Management System.** A shared-printer scheduler that uses a FIFO queue for fair processing of normal jobs, a binary max-heap to prioritise urgent jobs, and a hash map for constant-time job tracking and cancellation.

Built with Java 17+ and Spring Boot, with a vanilla HTML/CSS/JS frontend.

## Data structures (all custom, no `PriorityQueue` / `ArrayDeque` / `java.util.HashMap`)

All in `src/main/java/com/printflow/scheduler/`:

| Structure | File | Purpose |
|---|---|---|
| Linked-node FIFO queue | `JobQueue.java` | NORMAL jobs in arrival order |
| Array-based binary max-heap | `MaxHeap.java` | URGENT/HIGH jobs; key = `(level, -arrivalSequence)` |
| Separate-chaining hash map | `JobHashMap.java` | Job ID → job object: search, status, cancel |
| Scheduler | `PrintScheduler.java` | Submit, select next, complete, cancel (lazy deletion) |

Cancelling a job uses **lazy deletion**. Only the job's status in the hash map is set to `CANCELLED`, and the scheduler discards the job when it reaches the queue front or the heap top.

## Complexity

| Operation | Time |
|---|---|
| Submit normal job | O(1) |
| Submit urgent/high job | O(log n) |
| Search / cancel by ID | O(1) average |
| Start next urgent/high job | O(log n) |
| Start next normal job | O(1) |

## Run

Requires JDK 17 or newer. You don't need to install Maven: the included wrapper downloads it.

```bash
mvnw.cmd test              # Windows: run JUnit tests   (macOS/Linux: ./mvnw test)
mvnw.cmd spring-boot:run   # start the server on http://localhost:8080
```

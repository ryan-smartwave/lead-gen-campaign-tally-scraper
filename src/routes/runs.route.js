import { Router } from "express";
import * as runs from "../controllers/runs.controller.js";
import { catchAsync } from "../utils/ApiError.js";

const router = Router();

router.post("/", catchAsync(runs.create));
router.get("/active", catchAsync(runs.active));
// Stops a live run, or dismisses a finished one's event log.
router.delete("/active", catchAsync(runs.stopOrClear));
router.get("/events", catchAsync(runs.events));

export default router;

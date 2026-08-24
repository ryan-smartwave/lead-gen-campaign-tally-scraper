import { Router } from "express";
import businesses from "./businesses.route.js";
import runs from "./runs.route.js";
import { getHealth } from "../controllers/health.controller.js";
import { getPreflight } from "../controllers/preflight.controller.js";
import { catchAsync } from "../utils/ApiError.js";

const router = Router();

router.get("/health", catchAsync(getHealth));
router.get("/preflight", catchAsync(getPreflight));
router.use("/businesses", businesses);
router.use("/runs", runs);

export default router;

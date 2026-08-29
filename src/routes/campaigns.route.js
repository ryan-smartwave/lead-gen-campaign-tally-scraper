import { Router } from "express";
import * as campaigns from "../controllers/campaigns.controller.js";
import { catchAsync } from "../utils/ApiError.js";

const router = Router();

router.get("/", catchAsync(campaigns.list));
router.post("/", catchAsync(campaigns.create));
router.patch("/:slug", catchAsync(campaigns.update));
router.delete("/:slug", catchAsync(campaigns.remove));

export default router;

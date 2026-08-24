import { Router } from "express";
import * as businesses from "../controllers/businesses.controller.js";
import { catchAsync } from "../utils/ApiError.js";

const router = Router();

router.get("/", catchAsync(businesses.list));
router.post("/", catchAsync(businesses.create));
router.patch("/:slug", catchAsync(businesses.update));
router.delete("/:slug", catchAsync(businesses.remove));

export default router;

"""
Mouse position tracking service that shares coordinates with FastAPI.
Run this alongside the FastAPI app to enable mouse-position-aware endpoints.
"""

import threading
from typing import Tuple
from fastapi import FastAPI
from pynput import mouse

class MouseTracker:
    def __init__(self):
        self.current_pos: Tuple[int, int] = (0, 0)
        self._lock = threading.Lock()
        
    def on_move(self, x: int, y: int):
        """Update current mouse position thread-safely."""
        with self._lock:
            self.current_pos = (x, y)
            
    def get_position(self) -> Tuple[int, int]:
        """Get current mouse position thread-safely."""
        with self._lock:
            return self.current_pos

# Global tracker instance
tracker = MouseTracker()

# Start mouse listener
listener = mouse.Listener(on_move=tracker.on_move)
listener.start()

# FastAPI router to add to main app
router = FastAPI(openapi_prefix="/mouse")

@router.get("/position")
async def get_mouse_position():
    """Get the current mouse position."""
    x, y = tracker.get_position()
    return {"x": x, "y": y}

# Export for FastAPI mount
app = router
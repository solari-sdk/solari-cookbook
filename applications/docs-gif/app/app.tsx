import { createRoot } from "react-dom/client";

import { TasksPage } from "./tasks";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<TasksPage />);

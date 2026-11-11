// Todo List client‑side logic with localStorage persistence

const STORAGE_KEY = "todos";

/** Retrieve todos from localStorage */
function loadTodos() {
  const data = localStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : [];
}

/** Save todos array to localStorage */
function saveTodos(todos) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}

/** Render the todo list */
function renderTodos() {
  const listEl = document.getElementById("todo-list");
  listEl.innerHTML = "";
  const todos = loadTodos();

  todos.forEach((todo, index) => {
    const li = document.createElement("li");
    li.setAttribute("role", "listitem");
    if (todo.completed) li.classList.add("completed");

    const span = document.createElement("span");
    span.textContent = todo.text;
    span.tabIndex = 0; // make focusable
    span.addEventListener("click", () => toggleTodo(index));
    span.addEventListener("keypress", (e) => {
      if (e.key === "Enter" || e.key === " ") toggleTodo(index);
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.setAttribute("aria-label", `Delete todo ${todo.text}`);
    delBtn.addEventListener("click", () => deleteTodo(index));

    li.appendChild(span);
    li.appendChild(delBtn);
    listEl.appendChild(li);
  });
}

/** Add a new todo */
function addTodo(text) {
  const todos = loadTodos();
  todos.push({ text: text.trim(), completed: false });
  saveTodos(todos);
  renderTodos();
}

/** Delete a todo by its index */
function deleteTodo(idx) {
  const todos = loadTodos();
  todos.splice(idx, 1);
  saveTodos(todos);
  renderTodos();
}

/** Toggle completed state */
function toggleTodo(idx) {
  const todos = loadTodos();
  todos[idx].completed = !todos[idx].completed;
  saveTodos(todos);
  renderTodos();
}

/** Form submission handler */
function handleFormSubmit(event) {
  event.preventDefault();
  const input = document.getElementById("todo-input");
  const value = input.value;
  if (value.trim() !== "") {
    addTodo(value);
    input.value = "";
  }
}

// Initialise
document.getElementById("todo-form").addEventListener("submit", handleFormSubmit);
renderTodos();

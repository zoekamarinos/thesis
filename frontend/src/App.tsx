import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import Dash from './pages/Dash.tsx';
import Home from './pages/Home.tsx';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Dash />} />
        <Route path="/dash" element={<Home />} />
      </Routes>
    </Router>
  );
}

export default App;
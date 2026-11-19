import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import Dash from './pages/Dashboard/Dash.tsx';
import Home from './pages/Home/Home.tsx';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/dash" element={<Dash />} />
        <Route path="/" element={<Home />} />
      </Routes>
    </Router>
  );
}

export default App;
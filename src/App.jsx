import { useState, useEffect } from 'react'
import './App.css'

function App() {
  // State for app-wide warehouse management
  const [bins, setBins] = useState([])
  const [selectedBin, setSelectedBin] = useState(null)
  const [skus, setSkus] = useState([])
  const [binContents, setBinContents] = useState([])
  const [panelVisible, setPanelVisible] = useState(true)

  // Load initial data from Airtable (we'll implement this next)
  useEffect(() => {
    console.log('App mounted, ready to load data from Airtable')
  }, [])

  return (
    <div id="app">
      {/* TODO: TopBar component */}
      <div id="topbar" className="topbar">
        <h1>Naghedi Warehouse Layout Editor</h1>
        <button onClick={() => setPanelVisible(!panelVisible)}>
          {panelVisible ? '◀ Hide Panel' : '▶ Show Panel'}
        </button>
      </div>

      <div id="main-layout">
        {/* TODO: Canvas component - 3D warehouse view */}
        <div id="canvas-container" className="canvas-container">
          <p>3D Canvas will render here</p>
        </div>

        {/* TODO: ControlPanel component */}
        <aside id="panel" className={`panel ${!panelVisible ? 'hidden' : ''}`}>
          <div className="panel-header">
            <h2>Warehouse Editor</h2>
          </div>
          <div className="panel-content">
            <p>Selected Bin: {selectedBin || 'None'}</p>
            <p>Total Bins: {bins.length}</p>
            <p>Total SKUs: {skus.length}</p>
          </div>
        </aside>
      </div>
    </div>
  )
}

export default App

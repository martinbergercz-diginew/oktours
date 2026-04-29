<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST');
header('Access-Control-Allow-Headers: Content-Type');

$stateFile = __DIR__ . '/offer-state.json';

// Initialize state file if it doesn't exist
if (!file_exists($stateFile)) {
    file_put_contents($stateFile, json_encode(new stdClass()));
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo file_get_contents($stateFile);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input) || !isset($input['id']) || !isset($input['checked'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid input']);
        exit;
    }

    $state = json_decode(file_get_contents($stateFile), true) ?: [];
    $id = basename($input['id']); // sanitize
    $state[$id] = (bool) $input['checked'];
    file_put_contents($stateFile, json_encode($state));
    echo json_encode(['ok' => true, 'state' => $state]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
